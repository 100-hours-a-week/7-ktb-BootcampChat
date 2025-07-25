// backend/routes/api/files.js
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const fileController = require('../../controllers/fileController');
const { upload, errorHandler } = require('../../middleware/upload');
// const AdvancedRateLimiter = require('../../middleware/rateLimiter'); // 부하테스트용 제거

// Rate Limiter 초기화 (부하테스트용 제거)
// const rateLimiter = new AdvancedRateLimiter();

// 파일 업로드 (부하테스트용 Rate Limiting 제거)
router.post('/upload',
  auth,
  upload.single('file'),
  errorHandler,
  fileController.uploadFile
);

// 파일 다운로드
router.get('/download/:filename',
  auth,
  fileController.downloadFile
);

// 파일 보기 (미리보기용)
router.get('/view/:filename',
  auth,
  fileController.viewFile
);

// 파일 삭제
router.delete('/:id',
  auth,
  fileController.deleteFile
);

module.exports = router;