require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const compression = require('compression');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const { router: roomsRouter, initializeSocket } = require('./routes/api/rooms');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);

// Keep-Alive 최적화
server.keepAliveTimeout = 65000; // 65초
server.headersTimeout = 66000; // 66초
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
app.use(compression()); // 🚀 gzip 압축 (응답 크기 70% 감소)
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' })); // 메모리 제한
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// OPTIONS 요청에 대한 처리
app.options('*', cors(corsOptions));

// 정적 파일 제공 (캐싱 극대화)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '1y', // 1년 캐싱
  etag: true,
  lastModified: true,
  setHeaders: (res, path) => {
    if (path.endsWith('.jpg') || path.endsWith('.png') || path.endsWith('.gif')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 이미지 영구 캐싱
    }
  }
}));

// 성능 모니터링 미들웨어
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // 응답 완료 시 실행
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const status = res.statusCode;
    
    // 개발 환경에서 모든 요청 로깅
    if (process.env.NODE_ENV === 'development') {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${status} (${duration}ms)`);
    }
    
    // 느린 요청 경고 (500ms 이상)
    if (duration > 500) {
      console.warn(`🐌 느린 요청: ${req.method} ${req.originalUrl} - ${duration}ms`);
    }
    
    // 에러 요청 로깅
    if (status >= 400) {
      console.error(`❌ 에러 요청: ${req.method} ${req.originalUrl} - ${status} (${duration}ms)`);
    }
  });
  
  next();
});

// 기본 상태 체크
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    pid: process.pid
  });
});

// API 경로에도 health 체크 추가
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    pid: process.pid
  });
});

// 캐시 상태 확인 (개발용)
app.get('/api/cache/stats', async (req, res) => {
  try {
    const cache = require('./services/simpleCache');
    const memoryCache = require('./services/memoryCache');
    
    const redisStats = await cache.getStats();
    const memoryStats = memoryCache.getStats();
    
    res.json({
      success: true,
      redis: redisStats,
      memory: memoryStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DB 최적화 상태 확인
app.get('/api/db/stats', async (req, res) => {
  try {
    const dbIndexService = require('./services/dbIndexService');
    const queryOptimizer = require('./services/queryOptimizer');
    
    const indexStats = await dbIndexService.getIndexStats();
    const queryStats = queryOptimizer.getQueryStats();
    
    res.json({
      success: true,
      indexes: indexStats,
      queries: queryStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 쿼리 성능 분석 (개발용)
app.get('/api/db/analyze/:collection', async (req, res) => {
  try {
    const { collection } = req.params;
    const query = req.query.q ? JSON.parse(req.query.q) : {};
    
    const dbIndexService = require('./services/dbIndexService');
    const mongoose = require('mongoose');
    
    let targetCollection;
    switch (collection) {
      case 'rooms': targetCollection = mongoose.connection.collection('rooms'); break;
      case 'users': targetCollection = mongoose.connection.collection('users'); break;
      case 'messages': targetCollection = mongoose.connection.collection('messages'); break;
      default: throw new Error('Invalid collection');
    }
    
    const analysis = await dbIndexService.analyzeQuery(targetCollection, query);
    
    res.json({
      success: true,
      collection,
      query,
      analysis,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API 라우트 마운트
app.use('/api', routes);

// Socket.IO 설정 (기본)
const io = socketIO(server, { cors: corsOptions });
require('./sockets/chat')(io);
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

// MongoDB 연결 최적화 설정
const mongoOptions = {
  // 연결 풀 설정
  maxPoolSize: 10, // 최대 연결 수
  minPoolSize: 2,  // 최소 연결 수
  maxIdleTimeMS: 30000, // 30초 후 유휴 연결 해제
  serverSelectionTimeoutMS: 5000, // 서버 선택 타임아웃
  socketTimeoutMS: 45000, // 소켓 타임아웃
  
  // 안정성
  retryWrites: true,
  
  // 압축 (MongoDB 4.2+ 지원)
  compressors: ['zlib'],
};

// MongoDB 연결 및 서버 시작
async function startServer() {
  try {
    console.log('🔗 MongoDB 연결 중...');
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/chatapp', mongoOptions);
    
    console.log('✅ MongoDB 연결 완료 (최적화됨)');
    console.log(`📊 연결 풀: 최소 ${mongoOptions.minPoolSize}, 최대 ${mongoOptions.maxPoolSize}`);
    
    // DB 최적화 초기화
    console.log('🔧 DB 최적화 초기화 중...');
    try {
      const dbIndexService = require('./services/dbIndexService');
      await dbIndexService.createAllIndexes();
      console.log('✅ DB 최적화 완료!');
    } catch (error) {
      console.warn('⚠️  DB 최적화 건너뜀:', error.message);
    }
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다.`);
      console.log('Environment:', process.env.NODE_ENV || 'development');
      console.log('API Base URL:', `http://0.0.0.0:${PORT}/api`);
    });
    
  } catch (err) {
    console.error('❌ MongoDB 연결 실패:', err);
    process.exit(1);
  }
}

startServer();

module.exports = { app, server };