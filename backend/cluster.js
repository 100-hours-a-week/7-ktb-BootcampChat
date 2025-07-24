const cluster = require('cluster');
const os = require('os');

const numCPUs = os.cpus().length;
console.log(`🚀 CPU 개수: ${numCPUs}개`);

if (cluster.isMaster) {
  console.log(`🎯 마스터 프로세스 ${process.pid} 시작`);
  
  // CPU 개수만큼 워커 생성
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  
  // 워커 종료 시 재시작
  cluster.on('exit', (worker, code, signal) => {
    console.log(`💀 워커 ${worker.process.pid} 종료 (${signal || code})`);
    console.log('🔄 새 워커 시작...');
    cluster.fork();
  });
  
  // 성능 모니터링
  setInterval(() => {
    const workers = Object.keys(cluster.workers).length;
    console.log(`📊 활성 워커: ${workers}/${numCPUs}`);
  }, 30000); // 30초마다
  
} else {
  // 워커 프로세스에서 실제 서버 실행
  require('./server.js');
  console.log(`👷 워커 ${process.pid} 시작됨`);
}

// 그레이스풀 셧다운
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM 받음, 서버 종료 중...');
  
  if (cluster.isMaster) {
    for (const id in cluster.workers) {
      cluster.workers[id].kill();
    }
  }
  
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT 받음, 서버 종료 중...');
  
  if (cluster.isMaster) {
    for (const id in cluster.workers) {
      cluster.workers[id].kill();
    }
  }
  
  process.exit(0);
}); 