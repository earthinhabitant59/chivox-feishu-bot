const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('crypto');
const FormData = require('form-data');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { recordId, audioUrl, text, tableId, appToken } = req.body;

  if (!audioUrl || !text || !recordId) {
    return res.status(400).send('缺少必要参数: audioUrl, text, recordId');
  }

  // 立即告诉飞书收到了，避免超时
  res.status(200).send({ status: '评测进行中', recordId });

  try {
    // 1. 下载音频/视频文件
    console.log(`开始下载附件: ${audioUrl}`);
    const fileResp = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${await getFeishuToken()}`,
      },
      timeout: 30000,
    });
    const audioBuffer = Buffer.from(fileResp.data);
    console.log(`附件下载完成，大小: ${audioBuffer.length} bytes`);

    // 2. 如果是视频(mp4/mov)，提取音频（驰声支持直接发mp4，无需转换）
    // 驰声支持: wav, mp3, m4a, mp4, ogg, flac
    const audioType = detectAudioType(audioUrl);

    // 3. 调用驰声评测
    console.log('开始驰声评测...');
    const assessResult = await chivoxAssess(audioBuffer, audioType, text);
    console.log('驰声评测完成:', JSON.stringify(assessResult));

    // 4. 提取评测结果
    const overall = assessResult.overall || 0;
    const accuracy = assessResult.accuracy || 0;
    const fluency = assessResult.fluency || 0;
    const integrity = assessResult.integrity || 0;

    // 提取标红单词（得分低于60的单词）
    const lowScoreWords = [];
    if (assessResult.words && Array.isArray(assessResult.words)) {
      assessResult.words.forEach(w => {
        if (w.score < 60 && w.text && w.text !== 'sil') {
          lowScoreWords.push(w.text);
        }
      });
    }
    const markedWords = [...new Set(lowScoreWords)].join(', ');

    // 5. 用DeepSeek生成彩虹反馈
    console.log('生成AI反馈...');
    const aiFeedback = await generateFeedback({
      overall, accuracy, fluency, integrity, markedWords
    });

    // 6. 写回飞书作业表
    console.log('写回飞书...');
    await updateFeishuRecord({
      appToken: appToken || process.env.FEISHU_APP_TOKEN,
      tableId: tableId || process.env.FEISHU_TABLE_ID,
      recordId,
      fields: {
        '评测总分': Math.round(overall),
        '准确度': Math.round(accuracy),
        '流利度': Math.round(fluency),
        '完整度': Math.round(integrity),
        '标红单词': markedWords,
        'AI反馈': aiFeedback,
        '反馈状态': '已反馈',
      }
    });

    console.log(`记录 ${recordId} 评测完成并写回飞书`);

  } catch (err) {
    console.error('评测流程出错:', err.message, err.stack);
    // 出错时写回错误状态
    try {
      await updateFeishuRecord({
        appToken: appToken || process.env.FEISHU_APP_TOKEN,
        tableId: tableId || process.env.FEISHU_TABLE_ID,
        recordId,
        fields: { 'AI反馈': `评测失败: ${err.message}` }
      });
    } catch (e) {
      console.error('写回错误状态失败:', e.message);
    }
  }
};

// ── 驰声评测 ────────────────────────────────────
function chivoxAssess(audioBuffer, audioType, text) {
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
        reject(new Error('驰声评测超时（30s）'));
      }
    }, 30000);

    ws.on('open', () => {
      console.log('驰声WebSocket连接成功');
      // 发送配置
      ws.send(JSON.stringify({
        config: {
          coreType: 'en.pred.score',
          text: text,
          rank: 100,
        },
        audio: {
          audioType: audioType,
          sampleRate: 16000,
          channel: 1,
          sampleBytes: 2,
        }
      }));

      // 分片发送音频（每片32KB）
      const chunkSize = 32 * 1024;
      let offset = 0;
      const sendChunk = () => {
        if (offset >= audioBuffer.length) {
          // 发送结束标志
          ws.send(JSON.stringify({ end: true }));
          return;
        }
        const chunk = audioBuffer.slice(offset, offset + chunkSize);
        ws.send(chunk);
        offset += chunkSize;
        setTimeout(sendChunk, 50);
      };
      sendChunk();
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('驰声返回:', JSON.stringify(msg).slice(0, 200));

      if (msg.status === 0 && msg.result) {
        // 最终结果
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve(msg.result);
      } else if (msg.status !== undefined && msg.status !== 0) {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        reject(new Error(`驰声错误 status=${msg.status}: ${msg.message || ''}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error(`驰声WebSocket错误: ${err.message}`));
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

// ── 检测音频类型 ──────────────────────────────────
function detectAudioType(url) {
  const lower = (url || '').toLowerCase();
  if (lower.includes('.mp3')) return 'mp3';
  if (lower.includes('.m4a')) return 'm4a';
  if (lower.includes('.wav')) return 'wav';
  if (lower.includes('.ogg')) return 'ogg';
  if (lower.includes('.flac')) return 'flac';
  return 'mp4'; // 默认mp4，驰声支持直接评测
}

// ── 飞书 Token ────────────────────────────────────
let _feishuToken = null;
let _feishuTokenExpiry = 0;

async function getFeishuToken() {
  if (_feishuToken && Date.now() < _feishuTokenExpiry) return _feishuToken;
  const resp = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET },
    { timeout: 10000 }
  );
  _feishuToken = resp.data.tenant_access_token;
  _feishuTokenExpiry = Date.now() + (resp.data.expire - 60) * 1000;
  return _feishuToken;
}

// ── 写回飞书记录 ──────────────────────────────────
async function updateFeishuRecord({ appToken, tableId, recordId, fields }) {
  const token = await getFeishuToken();
  await axios.put(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { fields },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    }
  );
}

// ── DeepSeek生成反馈 ──────────────────────────────
async function generateFeedback({ overall, accuracy, fluency, integrity, markedWords }) {
  const prompt = `你是一位专业的英语指导老师，请根据学生的朗读评测结果，用温暖鼓励的语气写一段30-50字的反馈。

评测结果：
- 总分：${overall}/100
- 准确度：${accuracy}/100
- 流利度：${fluency}/100  
- 完整度：${integrity}/100
- 需要注意的单词：${markedWords || '无'}

要求：直接写反馈内容，不要加任何标题或前缀。`;

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
}
