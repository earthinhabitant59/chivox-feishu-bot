const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('crypto');

module.exports = async (req, res) => {
    // 飞书 Webhook 会发来 recordId, audioUrl, text
    const { recordId, audioUrl, text } = req.body;
    
    if (!audioUrl || !text) {
        return res.status(400).send("缺少必要参数");
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', process.env.SECRET_KEY)
        .update(process.env.APP_KEY + timestamp)
        .digest('hex');

    const wsUrl = `wss://cloud.chivox.com/ws?appKey=${process.env.APP_KEY}&timestamp=${timestamp}&sig=${signature}&version=2`;
    
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        // 1. 发送配置 JSON
        ws.send(JSON.stringify({
            "config": { "text": text, "coreProvideType": "native", "rank": 100 },
            "audio": { "audioType": "wav", "sampleRate": 16000 }
        }));
        
        // 这里需要下载音频并切片发送，为了保持简洁，先做一个连接测试
        console.log("连接成功，等待数据...");
    });

    ws.on('message', (data) => {
        const result = JSON.parse(data);
        console.log("收到测评结果:", result);
        // 后续逻辑：调用飞书 API 更新表格
    });

    // 告诉飞书我们收到了，开始处理
    res.status(200).send({ status: "测评进行中", recordId });
};