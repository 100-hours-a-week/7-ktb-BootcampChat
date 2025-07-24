require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { router: roomsRouter, initializeSocket } = require('./routes/api/rooms');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// trust proxy 설정 추가
app.set('trust proxy', 1);

// CORS 설정
const corsOptions = {
  origin: [
    'https://chat.goorm-ktb-007.goorm.team',
    'https://bootcampchat-fe.run.goorm.site',
    'https://bootcampchat-hgxbv.dev-k8s.arkain.io',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'https://localhost:3000',
    'https://localhost:3001',
    'https://localhost:3002',
    'http://0.0.0.0:3000',
    'https://0.0.0.0:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'x-auth-token', 
    'x-session-id',
    'Cache-Control',
    'Pragma'
  ],
  exposedHeaders: ['x-auth-token', 'x-session-id']
};

// 기본 미들웨어
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OPTIONS 요청에 대한 처리
app.options('*', cors(corsOptions));

// 정적 파일 제공
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 요청 로깅
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// 기본 상태 체크
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV
  });
});

// API 라우트 마운트
app.use('/api', routes);

// Socket.IO 설정
const io = socketIO(server, { cors: corsOptions });
require('./sockets/chat')(io);

// Socket.IO 객체 전달
initializeSocket(io);

// 404 에러 핸들러
app.use((req, res) => {
  console.log('404 Error:', req.originalUrl);
  res.status(404).json({
    success: false,
    message: '요청하신 리소스를 찾을 수 없습니다.',
    path: req.originalUrl
  });
});

// 글로벌 에러 핸들러
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '서버 에러가 발생했습니다.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 클러스터 및 최적화 서비스 초기화
const socketClusterService = require('./services/socketClusterService');
const queueService = require('./services/queueService');
const monitoringService = require('./services/monitoringService');
const rateLimiter = require('./middleware/rateLimiter');

// 클러스터 모드 시작
const shouldStartServer = process.env.NODE_ENV === 'production' 
  ? socketClusterService.startCluster()
  : true;

if (shouldStartServer) {
  // MongoDB 연결 최적화
  mongoose.connect(process.env.MONGO_URI, {
    maxPoolSize: 50, // 최대 연결 풀 크기
    minPoolSize: 5,  // 최소 연결 풀 크기
    maxIdleTimeMS: 30000, // 30초 후 유휴 연결 종료
    serverSelectionTimeoutMS: 5000, // 5초 서버 선택 타임아웃
    socketTimeoutMS: 45000, // 45초 소켓 타임아웃
    bufferMaxEntries: 0, // 버퍼 비활성화 (즉시 에러)
    bufferCommands: false
  })
  .then(async () => {
    console.log('✅ MongoDB Connected with optimized settings');
    
    // Socket.IO Redis Adapter 설정
    const io = require('./sockets/chat')(server);
    await socketClusterService.setupRedisAdapter(io);
    
    // 연결 풀 관리
    socketClusterService.manageConnectionPool(io);
    
    // 서버 상태 모니터링
    socketClusterService.monitorServerHealth(io);
    
    // Rate Limiter 적용
    app.use('/api/auth', rateLimiter.getAuthLimiter());
    app.use('/api/messages', rateLimiter.getMessageLimiter());
    app.use('/api/files', rateLimiter.getFileUploadLimiter());
    app.use('/api/rooms', rateLimiter.getRoomCreationLimiter());
    app.use('/api/ai', rateLimiter.getAILimiter());
    app.use('/api', rateLimiter.getGlobalLimiter());
    
    // 모니터링 미들웨어
    app.use(monitoringService.getRequestTracker());
    
    // 스케줄링된 작업 시작
    queueService.scheduleCleanupTasks();
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT} (PID: ${process.pid})`);
      console.log('🔥 Environment:', process.env.NODE_ENV);
      console.log('📊 Cluster mode:', process.env.NODE_ENV === 'production' ? 'enabled' : 'disabled');
      console.log('💾 Redis caching: enabled');
      console.log('⚡ Queue processing: enabled');
      console.log('📈 Monitoring: enabled');
      console.log('🛡️ Rate limiting: enabled');
      console.log('API Base URL:', `http://0.0.0.0:${PORT}/api`);
    });
    
    // 서버 종료 시 정리 작업
    process.on('SIGTERM', async () => {
      console.log('🔄 SIGTERM received, shutting down gracefully...');
      await socketClusterService.cleanup();
      await queueService.cleanup();
      server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    });
    
  })
  .catch(err => {
    console.error('❌ Server startup error:', err);
    process.exit(1);
  });
}

module.exports = { app, server };