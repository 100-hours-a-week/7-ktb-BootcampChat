const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const Room = require('../../models/Room');
const User = require('../../models/User');
const { rateLimit } = require('express-rate-limit');
const cache = require('../../services/simpleCache');
const memoryCache = require('../../services/memoryCache');
const queryOptimizer = require('../../services/queryOptimizer');
let io;

// 속도 제한 설정
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1분
  max: 60, // IP당 최대 요청 수
  message: {
    success: false,
    error: {
      message: '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.',
      code: 'TOO_MANY_REQUESTS'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Socket.IO 초기화 함수
const initializeSocket = (socketIO) => {
  io = socketIO;
};

// 서버 상태 확인
router.get('/health', async (req, res) => {
  try {
    const isMongoConnected = require('mongoose').connection.readyState === 1;
    const recentRoom = await Room.findOne()
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    const start = process.hrtime();
    await Room.findOne().select('_id').lean();
    const [seconds, nanoseconds] = process.hrtime(start);
    const latency = Math.round((seconds * 1000) + (nanoseconds / 1000000));

    const status = {
      success: true,
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: isMongoConnected,
          latency
        }
      },
      lastActivity: recentRoom?.createdAt
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.status(isMongoConnected ? 200 : 503).json(status);

  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      success: false,
      error: {
        message: '서비스 상태 확인에 실패했습니다.',
        code: 'HEALTH_CHECK_FAILED'
      }
    });
  }
});

// 채팅방 목록 조회 (페이징 적용 + 캐싱)
router.get('/', [limiter, auth], async (req, res) => {
  try {
    // 쿼리 파라미터 검증 (페이지네이션)
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize) || 10), 50);
    const skip = page * pageSize;

    // 정렬 설정
    const allowedSortFields = ['createdAt', 'name', 'participantsCount'];
    const sortField = allowedSortFields.includes(req.query.sortField) 
      ? req.query.sortField 
      : 'createdAt';
    const sortOrder = ['asc', 'desc'].includes(req.query.sortOrder)
      ? req.query.sortOrder
      : 'desc';

    // 검색 필터 구성
    const filter = {};
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: 'i' };
    }

    // 🚀 이중 캐싱: 메모리 → Redis 순서로 확인 (검색이 없는 경우만)
    if (!req.query.search) {
      const cacheKey = `rooms:${page}:${pageSize}:${sortField}:${sortOrder}`;
      
      // 1차: 초고속 메모리 캐시 확인
      let cachedResult = memoryCache.get(cacheKey);
      if (cachedResult) {
        console.log('⚡ 메모리 캐시 히트');
        return res.json(cachedResult);
      }
      
      // 2차: Redis 캐시 확인
      cachedResult = await cache.getRoomList(page, pageSize, sortField, sortOrder);
      if (cachedResult) {
        // Redis에서 가져온 데이터를 메모리에도 저장 (60초)
        memoryCache.set(cacheKey, cachedResult, 60);
        return res.json(cachedResult);
      }
    }

    // 총 문서 수 조회
    const totalCount = await Room.countDocuments(filter);

    // 🚀 최적화된 채팅방 목록 조회
    const startTime = Date.now();
    const rooms = await queryOptimizer.getOptimizedRooms(filter, {
      page,
      pageSize,
      sortField,
      sortOrder,
      includeParticipants: true
    });
    queryOptimizer.trackQuery('getRooms', startTime);

    // 안전한 응답 데이터 구성 
    const safeRooms = rooms.map(room => {
      if (!room) return null;

      const creator = room.creator || { _id: 'unknown', name: '알 수 없음', email: '' };
      const participants = Array.isArray(room.participants) ? room.participants : [];

      return {
        _id: room._id?.toString() || 'unknown',
        name: room.name || '제목 없음',
        hasPassword: !!room.hasPassword,
        creator: {
          _id: creator._id?.toString() || 'unknown',
          name: creator.name || '알 수 없음',
          email: creator.email || ''
        },
        participants: participants.filter(p => p && p._id).map(p => ({
          _id: p._id.toString(),
          name: p.name || '알 수 없음',
          email: p.email || ''
        })),
        participantsCount: participants.length,
        createdAt: room.createdAt || new Date(),
        isCreator: creator._id?.toString() === req.user.id,
      };
    }).filter(room => room !== null);

    // 메타데이터 계산    
    const totalPages = Math.ceil(totalCount / pageSize);
    const hasMore = skip + rooms.length < totalCount;

    // 응답 데이터 구성
    const responseData = {
      success: true,
      data: safeRooms,
      metadata: {
        total: totalCount,
        page,
        pageSize,
        totalPages,
        hasMore,
        currentCount: safeRooms.length,
        sort: {
          field: sortField,
          order: sortOrder
        }
      }
    };

    // 🚀 이중 캐시에 저장 (검색이 없는 경우만)
    if (!req.query.search) {
      const cacheKey = `rooms:${page}:${pageSize}:${sortField}:${sortOrder}`;
      
      // 메모리 캐시에 즉시 저장 (60초)
      memoryCache.set(cacheKey, responseData, 60);
      
      // Redis 캐시에 저장 (5분)
      await cache.cacheRoomList(page, pageSize, sortField, sortOrder, responseData);
    }

    // 캐시 설정
    res.set({
      'Cache-Control': 'private, max-age=10',
      'Last-Modified': new Date().toUTCString()
    });

    // 응답 전송
    res.json(responseData);

  } catch (error) {
    console.error('방 목록 조회 에러:', error);
    const errorResponse = {
      success: false,
      error: {
        message: '채팅방 목록을 불러오는데 실패했습니다.',
        code: 'ROOMS_FETCH_ERROR'
      }
    };

    if (process.env.NODE_ENV === 'development') {
      errorResponse.error.details = error.message;
      errorResponse.error.stack = error.stack;
    }

    res.status(500).json(errorResponse);
  }
});

// 채팅방 생성
router.post('/', auth, async (req, res) => {
  try {
    const { name, password } = req.body;
    
    if (!name?.trim()) {
      return res.status(400).json({ 
        success: false,
        message: '방 이름은 필수입니다.' 
      });
    }

    const newRoom = new Room({
      name: name.trim(),
      creator: req.user.id,
      participants: [req.user.id],
      password: password
    });

    const savedRoom = await newRoom.save();
    const populatedRoom = await Room.findById(savedRoom._id)
      .populate('creator', 'name email')
      .populate('participants', 'name email');
    
    // Socket.IO를 통해 새 채팅방 생성 알림
    if (io) {
      io.to('room-list').emit('roomCreated', {
        ...populatedRoom.toObject(),
        password: undefined
      });
    }
    
    res.status(201).json({
      success: true,
      data: {
        ...populatedRoom.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 생성 에러:', error);
    res.status(500).json({ 
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message 
    });
  }
});

// 특정 채팅방 조회
router.get('/:roomId', auth, async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId)
      .populate('creator', 'name email')
      .populate('participants', 'name email');

    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    res.json({
      success: true,
      data: {
        ...room.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('Room fetch error:', error);
    res.status(500).json({
      success: false,
      message: '채팅방 정보를 불러오는데 실패했습니다.'
    });
  }
});

// 채팅방 입장
router.post('/:roomId/join', auth, async (req, res) => {
  try {
    const { password } = req.body;
    console.log(`🔐 방 입장 시도: ${req.params.roomId}, 사용자: ${req.user.id}, 비밀번호 있음: ${!!password}`);
    
    const room = await Room.findById(req.params.roomId).select('+password');
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 비밀번호 확인
    if (room.hasPassword) {
      console.log(`🔒 비밀번호 보호된 방: ${room.name}, 입력된 비밀번호: "${password}"`);
      
      if (!password) {
        console.log('❌ 비밀번호 미입력');
        return res.status(401).json({
          success: false,
          code: 'ROOM_PASSWORD_REQUIRED',
          message: '이 채팅방은 비밀번호가 필요합니다.'
        });
      }
      
      const isPasswordValid = await room.checkPassword(password);
      console.log(`🔑 비밀번호 검증 결과: ${isPasswordValid}`);
      
      if (!isPasswordValid) {
        console.log('❌ 비밀번호 불일치');
        return res.status(401).json({
          success: false,
          code: 'INVALID_ROOM_PASSWORD',
          message: '비밀번호가 일치하지 않습니다.'
        });
      }
    }

    // 참여자 목록에 추가
    if (!room.participants.includes(req.user.id)) {
      room.participants.push(req.user.id);
      await room.save();
    }

    const populatedRoom = await room.populate('participants', 'name email');

    // Socket.IO를 통해 참여자 업데이트 알림
    if (io) {
      io.to(req.params.roomId).emit('roomUpdate', {
        ...populatedRoom.toObject(),
        password: undefined
      });
    }

    res.json({
      success: true,
      data: {
        ...populatedRoom.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 입장 에러:', error);
    res.status(500).json({
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message
    });
  }
});

// 채팅방 삭제
router.delete('/:roomId', auth, async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId);
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 방 생성자만 삭제할 수 있도록 권한 확인
    if (room.creator.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '채팅방을 삭제할 권한이 없습니다. 방 생성자만 삭제할 수 있습니다.'
      });
    }

    // 채팅방의 모든 메시지 조회
    const Message = require('../../models/Message');
    const messages = await Message.find({ room: room._id });
    
    // 파일 메시지에서 파일 ID 추출
    const fileIds = messages
      .filter(msg => msg.type === 'file' && msg.file)
      .map(msg => msg.file);

    // 파일 삭제
    if (fileIds.length > 0) {
      const File = require('../../models/File');
      await File.deleteMany({ _id: { $in: fileIds } });
    }

    // 메시지 삭제
    await Message.deleteMany({ room: room._id });

    // 채팅방 삭제
    await Room.findByIdAndDelete(room._id);

    // Socket.IO를 통해 채팅방 삭제 알림
    if (io) {
      io.to('room-list').emit('roomDeleted', room._id);
      io.to(room._id).emit('roomDeleted', {
        message: '채팅방이 삭제되었습니다.'
      });
    }

    res.json({
      success: true,
      message: '채팅방이 성공적으로 삭제되었습니다.'
    });
  } catch (error) {
    console.error('채팅방 삭제 에러:', error);
    res.status(500).json({
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message
    });
  }
});

module.exports = {
  router,
  initializeSocket
};