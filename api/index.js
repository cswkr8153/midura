// Vercel 서버리스 함수 진입점: Express 앱을 그대로 내보낸다. (모든 /api/* 요청이 여기로 온다)
module.exports = require('../server/server.js');
