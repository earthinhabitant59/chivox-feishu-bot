const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { recordId, fileToken, text } = req.body;

  if (!fileToken || !text || !recordId) {
    return res.status(400).json({ error: '缺少必要参数: fileToken, text, recordId' });
  }

  // 立即响应飞书，避免超时
  res.status(200).json({ status: '评测进行中', recordId });

  try {
    // 1. 获取飞书Token
    const feishuToken = await getFeishuToken();

    // 2. 通过附件ID下载文件
    console.log(`下载附件 fileToken: ${fileToken}`);
    const audioBuffer = await downloadFeishuFile(fileToken, feishuToken);
    console.log(`附件下载完成，大小: ${audioBuffer.length} bytes`);

    // 3. 调用驰声评测
    console.log('开始驰声评测...');
    const assessResult = await chivoxAssess(audioBuffer, text);
    console.log('驰声评测完成:', JSON.stringify(assessResult).slice(0, 300));

    // 4. 提取评测结果
    const overall = Math.round(assessResult.overall || 0);
    const accuracy = Math.round(assessResult.accuracy || 0);
    const fluency = Math.round(assessResult.fluency || 0);
    const integrity = Math.round(assessResult.integrity || 0);

    // 提取标红单词（得分低于60）
    const lowScoreWords = [];
    if (assessResult.words && Array.isArray(assessResult.words)) {
      assessResult.words.forEach(w => {
        if (w.score < 60 && w.text && w.text !== 'sil') {
          lowScoreWords.push(w.text);
        }
      });
    }
    const markedWords = [...new Set(lowScoreWords)].join(', ');

    // 5. DeepSeek生成彩虹反馈
    console.log('生成AI反馈...');
    const aiFeedback = await generateFeedback({ overall, accuracy, fluency, integrity, markedWords });

    // 6. 写回飞书
    console.log('写回飞书...');
    await updateFeishuRecord({
      recordId,
      fields: {
        '评测总分': overall,
        '准确度': accuracy,
        '流利度': fluency,
        '完整度': integrity,
        '标红单词': markedWords,
        'AI反馈': aiFeedback,
        '反馈状态': '已反馈',
      }
    }, feishuToken);

    console.log(`记录 ${recordId} 全部完成`);

  } catch (err) {
    console.error('评测出错:', err.message);
    try {
      const t = await getFeishuToken();
      await updateFeishuRecord({
        recordId,
        fields: { 'AI反馈': `评测失败: ${err.message}` }
      }, t);
    } catch (e) {
      console.error('写回错误状态失败:', e.message);
    }
  }
};

// ── 飞书Token ─────────────────────────────────────
let _token = null;
let _tokenExpiry = 0;

async function getFeishuToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const resp = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET },
    { timeout: 10000 }
  );
  _token = resp.data.tenant_access_token;
  _tokenExpiry = Date.now() + (resp.data.expire - 60) * 1000;
  return _token;
}

// ── 下载飞书附件 ──────────────────────────────────
async function downloadFeishuFile(fileToken, feishuToken) {
  const resp = await axios.get(
    `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`,
    {
      headers: { Authorization: `Bearer ${feishuToken}` },
      responseType: 'arraybuffer',
      timeout: 60000,
    }
  );
  return Buffer.from(resp.data);
}

// ── 驰声评测 ──────────────────────────────────────
function chivoxAssess(audioBuffer, text) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', process.env.SECRET_KEY)
      .update(process.env.APP_KEY + timestamp)
      .digest('hex');

    const wsUrl = `wss://cloud.chivox.com/ws?appKey=${process.env.APP_KEY}&timestamp=${timestamp}&sig=${signature}&version=2`;
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error('驰声评测超时（60s）'));
      }
    }, 60000);

    ws.on('open', () => {
      console.log('驰声WebSocket连接成功');
      ws.send(JSON.stringify({
        config: {
          coreType: 'en.pred.score',
          text: text,
          rank: 100,
        },
        audio: {
          audioType: 'mp4',
          sampleRate: 16000,
          channel: 1,
          sampleBytes: 2,
        }
      }));

      // 分片发送音频，每片32KB
      const chunkSize = 32 * 1024;
      let offset = 0;

      const sendChunk = () => {
        if (offset >= audioBuffer.length) {
          ws.send(JSON.stringify({ end: true }));
          console.log('音频发送完毕，等待评测结果...');
          return;
        }
        const chunk = audioBuffer.slice(offset, offset + chunkSize);
        ws.send(chunk);
        offset += chunkSize;
        setTimeout(sendChunk, 30);
      };

      sendChunk();
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('驰声消息 status:', msg.status);

        if (msg.status === 0 && msg.result) {
          clearTimeout(timeout);
          resolved = true;
          ws.close();
          resolve(msg.result);
        } else if (msg.status !== undefined && msg.status !== 0) {
          clearTimeout(timeout);
          resolved = true;
          ws.close();
          reject(new Error(`驰声错误 status=${msg.status}: ${msg.message || JSON.stringify(msg)}`));
        }
      } catch (e) {
        console.error('解析驰声消息失败:', e.message);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error(`驰声WebSocket错误: ${err.message}`));
      }
    });

    ws.on('close', () => clearTimeout(timeout));
  });
}

// ── 写回飞书记录 ──────────────────────────────────
async function updateFeishuRecord({ recordId, fields }, feishuToken) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = process.env.FEISHU_TABLE_ID;
  await axios.put(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { fields },
    {
      headers: {
        Authorization: `Bearer ${feishuToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );
}

// ── DeepSeek生成反馈 ──────────────────────────────
async function generateFeedback({ overall, accuracy, fluency, integrity, markedWords }) {
  try {
    const prompt = `你是一位专业的英语指导老师，请根据学生的朗读评测结果，用温暖鼓励的语气写一段30-50字的反馈。

评测结果：总分${overall}分，准确度${accuracy}分，流利度${fluency}分，完整度${integrity}分。${markedWords ? `需要注意的单词：${markedWords}。` : ''}

直接写反馈内容，不加标题。`;

    const resp = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.9,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    return resp.data.choices[0].message.content.trim();
  } catch (e) {
    console.error('DeepSeek生成失败:', e.message);
    return `朗读完成！总分${overall}分，${markedWords ? `注意练习：${markedWords}。` : '继续加油！'}`;
  }
}
