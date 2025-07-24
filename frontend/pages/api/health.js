export default function handler(req, res) {
  // GET 요청만 허용
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
      allowedMethods: ['GET']
    });
  }

  try {
    // 헬스 체크 응답
    const healthData = {
      status: 'OK',
      message: 'Application is healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      }
    };

    // 캐시 방지 헤더 설정
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.status(200).json(healthData);
  } catch (error) {
    console.error('Health check error:', error);
    
    return res.status(500).json({
      status: 'ERROR',
      message: 'Health check failed',
      timestamp: new Date().toISOString(),
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
} 