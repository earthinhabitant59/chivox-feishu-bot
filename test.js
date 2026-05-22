const crypto = require('crypto');

// 换成你自己的真实 Key
const APP_KEY = "177944054300014d";
const SECRET_KEY = "b63976516969180bdc11a80ab0f263ef";

const timestamp = Math.floor(Date.now() / 1000);
const str = APP_KEY + timestamp;
const signature = crypto.createHmac('sha256', SECRET_KEY).update(str).digest('hex');

console.log("生成的签名是:", signature);
console.log("现在的时间戳是:", timestamp);
console.log("请复制上面的签名去官网测试工具核对一下！");