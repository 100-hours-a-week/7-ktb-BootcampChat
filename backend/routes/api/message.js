const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const auth = require('../middleware/auth');
// const AdvancedRateLimiter = require('../../middleware/rateLimiter'); // 부하테스트용 제거

// Rate Limiter 초기화 (부하테스트용 제거)
// const rateLimiter = new AdvancedRateLimiter();

// 채팅방의 메시지 목록 조회 (부하테스트용 Rate Limiting 제거)
router.get('/rooms/:roomId/messages', auth, messageController.loadMessages);

module.exports = router;