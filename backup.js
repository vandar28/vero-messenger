const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class DatabaseBackup {
  constructor() {
    // Используем Render Disk если доступен, иначе локальную папку
    const useRenderDisk = fs.existsSync('/data') || process.env.USE_RENDER_DISK === 'true';
    
    if (useRenderDisk) {
      this.dbPath = '/data/database.sqlite';
      this.backupDir = '/data/backups';
      console.log('📁 Используем Render Disk: /data/');
    } else {
      this.dbPath = path.join(__dirname, 'database.sqlite');
      this.backupDir = path.join(__dirname, 'backups');
      console.log('📁 Используем локальную папку');
    }
    
    this.backupName = 'backup.sqlite.gz';
    this.tempBackupName = 'backup_temp.sqlite.gz';
    
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    
    this.isBackupInProgress = false;
    
    console.log('📁 Папка для бэкапов:', this.backupDir);
    console.log('📦 ОДИН бэкап (простая перезапись)');
    console.log('⚠️ Включена ПРОВЕРКА ВАЛИДНОСТИ перед сохранением');
  }

  // ===== ПРОВЕРКА ВАЛИДНОСТИ БД =====
  validateDatabase(data) {
    try {
      if (!data || data.length < 100) {
        console.log(`⚠️ БД слишком маленькая: ${data?.length || 0} байт`);
        return false;
      }
      
      const header = data.slice(0, 16).toString('hex');
      if (!header.startsWith('53514c69746520666f726d6174')) {
        console.log('⚠️ БД повреждена (не SQLite)');
        return false;
      }
      
      const str = data.toString('utf8', 0, Math.min(data.length, 5000));
      if (!str.includes('CREATE TABLE') && !str.includes('users')) {
        console.log('⚠️ БД не содержит таблиц');
        return false;
      }
      
      if (!str.includes('ad6@gmail.com')) {
        console.log('⚠️ В БД НЕТ АДМИНА! Бэкап НЕ будет сохранён');
        return false;
      }
      
      return true;
    } catch (error) {
      console.log('⚠️ Ошибка проверки БД:', error.message);
      return false;
    }
  }

  // ===== ПРОВЕРКА ВАЛИДНОСТИ БЭКАПА =====
  validateBackup(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      
      const stats = fs.statSync(filePath);
      if (stats.size < 100) return false;
      
      const compressed = fs.readFileSync(filePath);
      const data = zlib.gunzipSync(compressed);
      
      return this.validateDatabase(data);
    } catch (error) {
      return false;
    }
  }

  // ===== ПОЛУЧЕНИЕ ИНФОРМАЦИИ О БЭКАПЕ =====
  getBackupInfo() {
    const backupPath = path.join(this.backupDir, this.backupName);
    if (!fs.existsSync(backupPath)) return null;
    
    if (!this.validateBackup(backupPath)) return null;
    
    const stats = fs.statSync(backupPath);
    return {
      name: this.backupName,
      path: backupPath,
      size: stats.size,
      mtime: stats.mtime
    };
  }

  // ===== СОЗДАНИЕ БЭКАПА С ПРОВЕРКОЙ =====
  createBackup() {
    if (this.isBackupInProgress) {
      console.log('⏳ Бэкап уже выполняется');
      return null;
    }
    
    this.isBackupInProgress = true;
    
    try {
      // Проверяем существование БД
      if (!fs.existsSync(this.dbPath)) {
        console.log('❌ База данных не найдена');
        return null;
      }

      const stats = fs.statSync(this.dbPath);
      if (stats.size < 100) {
        console.log(`⚠️ БД слишком маленькая: ${stats.size} байт — ПРОПУСК`);
        return null;
      }

      const data = fs.readFileSync(this.dbPath);
      
      // ===== ПРОВЕРЯЕМ БД ПЕРЕД СОХРАНЕНИЕМ =====
      if (!this.validateDatabase(data)) {
        console.log('❌ БД НЕВАЛИДНА! Бэкап НЕ создан');
        return null;
      }

      const backupPath = path.join(this.backupDir, this.backupName);
      const tempPath = path.join(this.backupDir, this.tempBackupName);
      
      const compressed = zlib.gzipSync(data, { level: 9 });
      
      if (compressed.length < 100) {
        console.log(`⚠️ Сжатые данные слишком маленькие: ${compressed.length} байт — ПРОПУСК`);
        return null;
      }
      
      // Сохраняем ВРЕМЕННЫЙ бэкап
      fs.writeFileSync(tempPath, compressed);
      
      // Проверяем временный бэкап
      if (!this.validateBackup(tempPath)) {
        console.log('❌ ВРЕМЕННЫЙ БЭКАП НЕВАЛИДЕН! Удаляем...');
        fs.unlinkSync(tempPath);
        return null;
      }
      
      // Если валидный - переименовываем в основной
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
      fs.renameSync(tempPath, backupPath);
      
      const originalSize = (data.length / 1024 / 1024).toFixed(2);
      const compressedSize = (compressed.length / 1024 / 1024).toFixed(2);
      
      console.log(`✅ Бэкап создан: ${this.backupName}`);
      console.log(`📦 ${originalSize} MB → ${compressedSize} MB`);
      
      // Обновляем статус для фронтенда
      this.updateFrontendStatus();
      
      return backupPath;
      
    } catch (error) {
      console.error('❌ Ошибка создания бэкапа:', error);
      return null;
    } finally {
      this.isBackupInProgress = false;
    }
  }

  updateFrontendStatus() {
    try {
      const statusPath = path.join(__dirname, 'public', 'backup-status.json');
      const backupInfo = this.getBackupInfo();
      
      let status = {
        lastBackup: null,
        total: 0,
        max: 1,
        backups: []
      };
      
      if (backupInfo) {
        status = {
          lastBackup: backupInfo.mtime.toISOString(),
          total: 1,
          max: 1,
          backups: [{
            name: backupInfo.name,
            size: (backupInfo.size / 1024).toFixed(2) + ' KB',
            date: backupInfo.mtime.toISOString(),
            isLatest: true
          }]
        };
      }
      
      fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    } catch (e) {}
  }

  async restoreFromBackup() {
    console.log('\n🔄 ПОИСК БЭКАПА...');
    
    const backupInfo = this.getBackupInfo();
    
    if (!backupInfo) {
      console.log('ℹ️ Нет валидного бэкапа');
      return false;
    }
    
    console.log(`📥 Найден бэкап: ${backupInfo.name}`);
    console.log(`📅 Дата: ${backupInfo.mtime.toLocaleString('ru-RU')}`);
    console.log(`📦 Размер: ${(backupInfo.size / 1024).toFixed(2)} KB`);
    
    try {
      const compressed = fs.readFileSync(backupInfo.path);
      const data = zlib.gunzipSync(compressed);
      
      if (!this.validateDatabase(data)) {
        console.log('❌ БЭКАП ПОВРЕЖДЕН! Восстановление отменено');
        return false;
      }
      
      fs.writeFileSync(this.dbPath, data);
      console.log(`✅ БД восстановлена! Размер: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
      return true;
    } catch (error) {
      console.error('❌ Ошибка восстановления:', error);
      return false;
    }
  }

  async instantBackup(reason = 'изменение') {
    console.log(`⚡ Мгновенный бэкап (${reason})...`);
    const result = !!this.createBackup();
    
    // Если используется Render Disk, даём время на запись
    if (result && process.env.USE_RENDER_DISK === 'true') {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return result;
  }

  async fullBackup() {
    return this.instantBackup('завершение работы');
  }
}

const backup = new DatabaseBackup();

(async function restoreOnStart() {
  console.log('\n🔍 ПРОВЕРКА БАЗЫ ДАННЫХ ПРИ ЗАПУСКЕ...');
  
  let dbValid = false;
  let dbHasUsers = false;
  
  if (fs.existsSync(backup.dbPath)) {
    try {
      const stats = fs.statSync(backup.dbPath);
      if (stats.size >= 100) {
        const data = fs.readFileSync(backup.dbPath);
        dbValid = backup.validateDatabase(data);
        if (dbValid) {
          const str = data.toString('utf8', 0, Math.min(data.length, 5000));
          dbHasUsers = str.includes('ad6@gmail.com');
          console.log(`✅ Текущая БД валидна (${(stats.size / 1024).toFixed(2)} KB)`);
          console.log(`👤 Пользователи: ${dbHasUsers ? 'есть' : 'НЕТ!'}`);
        }
      }
    } catch (e) {
      console.log('⚠️ Ошибка проверки текущей БД:', e.message);
    }
  }
  
  if (!dbValid || !dbHasUsers) {
    console.log('⚠️ Текущая БД повреждена или пуста!');
    console.log('🔄 Запускаем восстановление из бэкапа...');
    await backup.restoreFromBackup();
  }
  
  backup.updateFrontendStatus();
  console.log('✅ Проверка БД завершена\n');
})();

// ===== БЭКАП КАЖДУЮ МИНУТУ ПРИ ИЗМЕНЕНИИ РАЗМЕРА =====
let lastDbSize = 0;

setInterval(async () => {
  try {
    if (!fs.existsSync(backup.dbPath)) {
      console.log('⚠️ БД исчезла! Восстанавливаем...');
      await backup.restoreFromBackup();
      return;
    }
    
    const stats = fs.statSync(backup.dbPath);
    const currentSize = stats.size;
    
    if (currentSize !== lastDbSize && currentSize > 100) {
      console.log(`📊 Размер БД изменился: ${lastDbSize} → ${currentSize} байт`);
      await backup.instantBackup('изменение размера');
      lastDbSize = currentSize;
    }
  } catch (e) {
    console.log('⚠️ Ошибка проверки БД:', e.message);
  }
}, 60 * 1000);

// ===== ПРОВЕРКА БД КАЖДЫЕ 30 СЕКУНД =====
setInterval(async () => {
  try {
    if (!fs.existsSync(backup.dbPath)) {
      console.log('⚠️ БД исчезла! Восстанавливаем...');
      await backup.restoreFromBackup();
      return;
    }
    
    const stats = fs.statSync(backup.dbPath);
    if (stats.size < 100) {
      console.log('⚠️ БД слишком маленькая! Восстанавливаем...');
      await backup.restoreFromBackup();
      return;
    }
    
    const data = fs.readFileSync(backup.dbPath);
    const str = data.toString('utf8', 0, Math.min(data.length, 2000));
    if (!str.includes('ad6@gmail.com')) {
      console.log('⚠️ В БД нет админа! Восстанавливаем из бэкапа...');
      await backup.restoreFromBackup();
    }
  } catch (e) {
    console.log('⚠️ Ошибка проверки БД:', e.message);
  }
}, 30 * 1000);

process.on('SIGINT', async () => {
  console.log('\n🔄 Бэкап перед выходом...');
  await backup.fullBackup();
  console.log('👋 Сервер остановлен');
  process.exit();
});

process.on('SIGTERM', async () => {
  console.log('\n🔄 Бэкап перед выходом...');
  await backup.fullBackup();
  console.log('👋 Сервер остановлен');
  process.exit();
});

setTimeout(async () => {
  await backup.instantBackup('старт');
}, 3000);

module.exports = backup;