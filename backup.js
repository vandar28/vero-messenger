const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

class DatabaseBackup {
  constructor() {
    this.dbPath = path.join(__dirname, 'database.sqlite');
    this.backupDir = path.join(__dirname, 'backups');
    this.maxBackups = 30; // Увеличил до 30 бэкапов
    
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    
    // Кеш последнего бэкапа в памяти
    this.lastBackupData = null;
    this.lastBackupTime = 0;
    this.isBackupInProgress = false;
    
    console.log('📁 Папка для бэкапов создана');
    console.log(`📦 Максимум бэкапов: ${this.maxBackups}`);
    console.log('⚡ Мгновенные бэкапы включены');
  }

  validateBackup(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      
      const stats = fs.statSync(filePath);
      if (stats.size < 100) {
        console.log(`⚠️ Бэкап ${path.basename(filePath)} слишком маленький (${stats.size} байт)`);
        return false;
      }
      
      const compressed = fs.readFileSync(filePath);
      const data = zlib.gunzipSync(compressed);
      
      const header = data.slice(0, 16).toString('hex');
      if (!header.startsWith('53514c69746520666f726d6174')) {
        console.log(`⚠️ Бэкап ${path.basename(filePath)} поврежден (не SQLite)`);
        return false;
      }
      
      const str = data.toString('utf8', 0, Math.min(data.length, 10000));
      if (!str.includes('CREATE TABLE') && !str.includes('users')) {
        console.log(`⚠️ Бэкап ${path.basename(filePath)} не содержит таблиц`);
        return false;
      }
      
      return true;
    } catch (error) {
      return false;
    }
  }

  getValidBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'))
        .sort();
      
      const validBackups = [];
      for (const file of files) {
        const filePath = path.join(this.backupDir, file);
        if (this.validateBackup(filePath)) {
          const stats = fs.statSync(filePath);
          validBackups.push({
            name: file,
            path: filePath,
            size: stats.size,
            mtime: stats.mtime
          });
        }
      }
      
      validBackups.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      return validBackups;
    } catch (e) {
      return [];
    }
  }

  // ===== МГНОВЕННЫЙ БЭКАП =====
  async instantBackup(reason = 'изменение') {
    // Защита от множественных одновременных бэкапов
    if (this.isBackupInProgress) {
      console.log(`⏳ Бэкап уже выполняется, пропускаем (${reason})`);
      return false;
    }
    
    this.isBackupInProgress = true;
    
    try {
      if (!fs.existsSync(this.dbPath)) {
        console.log('❌ База данных не найдена');
        return false;
      }

      const stats = fs.statSync(this.dbPath);
      if (stats.size < 100) {
        console.log('⚠️ БД слишком маленькая, пропускаем бэкап');
        return false;
      }

      // Проверяем, изменилась ли БД с последнего бэкапа
      const currentData = fs.readFileSync(this.dbPath);
      const currentHash = this.hashData(currentData);
      
      if (this.lastBackupData && this.lastBackupData.hash === currentHash) {
        // Данные не изменились, пропускаем
        this.isBackupInProgress = false;
        return false;
      }

      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      console.log(`📊 Мгновенный бэкап (${reason})... Размер: ${sizeMB} MB`);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `backup-${timestamp}.sqlite.gz`;
      const backupPath = path.join(this.backupDir, backupName);
      
      const compressed = zlib.gzipSync(currentData, { level: 9 });
      fs.writeFileSync(backupPath, compressed);
      
      // Сохраняем как latest
      const latestPath = path.join(this.backupDir, 'latest.sqlite.gz');
      fs.writeFileSync(latestPath, compressed);
      
      // Сохраняем в память
      this.lastBackupData = {
        hash: currentHash,
        data: currentData,
        time: Date.now(),
        path: backupPath
      };
      this.lastBackupTime = Date.now();
      
      const originalSize = (currentData.length / 1024 / 1024).toFixed(2);
      const compressedSize = (compressed.length / 1024 / 1024).toFixed(2);
      
      console.log(`✅ Мгновенный бэкап создан: ${backupName}`);
      console.log(`📦 ${originalSize} MB → ${compressedSize} MB`);
      
      // Очищаем старые бэкапы
      this.cleanOldBackups();
      
      return true;
      
    } catch (error) {
      console.error('❌ Ошибка мгновенного бэкапа:', error);
      return false;
    } finally {
      this.isBackupInProgress = false;
    }
  }

  // ===== ХЕШ ДЛЯ ПРОВЕРКИ ИЗМЕНЕНИЙ =====
  hashData(data) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(data).digest('hex');
  }

  // ===== ВОССТАНОВЛЕНИЕ ИЗ БЭКАПА =====
  async restoreFromBackup() {
    console.log('\n🔄 ПРОВЕРКА БЭКАПОВ...');
    
    // 1. Сначала пробуем локальный свежий бэкап
    const backups = this.getValidBackups();
    
    if (backups.length > 0) {
      const latest = backups[0];
      console.log(`📥 Найден бэкап: ${latest.name}`);
      console.log(`📅 Дата: ${latest.mtime.toLocaleString('ru-RU')}`);
      
      try {
        const compressed = fs.readFileSync(latest.path);
        const data = zlib.gunzipSync(compressed);
        
        fs.writeFileSync(this.dbPath, data);
        console.log(`✅ БД восстановлена! Размер: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
        return true;
      } catch (error) {
        console.error('❌ Ошибка восстановления:', error);
      }
    }
    
    console.log('⚠️ Нет валидных бэкапов');
    return false;
  }

  cleanOldBackups() {
    try {
      const backups = this.getValidBackups();
      
      if (backups.length <= this.maxBackups) {
        console.log(`✅ Всего ${backups.length} бэкапов (лимит ${this.maxBackups})`);
        return;
      }
      
      const toDelete = backups.slice(this.maxBackups);
      let deleted = 0;
      
      for (const backup of toDelete) {
        fs.unlinkSync(backup.path);
        deleted++;
        console.log(`🗑️ Удален старый бэкап: ${backup.name}`);
      }
      
      console.log(`✅ Очищено ${deleted} старых бэкапов. Осталось ${this.maxBackups}`);
      
    } catch (error) {
      console.error('❌ Ошибка очистки бэкапов:', error);
    }
  }

  // ===== ПРИНУДИТЕЛЬНЫЙ БЭКАП (для выхода) =====
  async fullBackup() {
    return this.instantBackup('завершение работы');
  }
}

const backup = new DatabaseBackup();

// ===== ВОССТАНОВЛЕНИЕ ПРИ СТАРТЕ =====
(async function restoreOnStart() {
  console.log('\n🔍 ПРОВЕРКА БАЗЫ ДАННЫХ ПРИ ЗАПУСКЕ...');
  
  let dbValid = false;
  let dbHasUsers = false;
  
  if (fs.existsSync(backup.dbPath)) {
    try {
      const stats = fs.statSync(backup.dbPath);
      if (stats.size >= 100) {
        const data = fs.readFileSync(backup.dbPath);
        const header = data.slice(0, 16).toString('hex');
        if (header.startsWith('53514c69746520666f726d6174')) {
          dbValid = true;
          const str = data.toString('utf8', 0, Math.min(data.length, 5000));
          dbHasUsers = str.includes('ad6@gmail.com') && str.includes('users');
          console.log(`✅ Текущая БД валидна (${(stats.size / 1024).toFixed(2)} KB)`);
          console.log(`👤 Пользователи: ${dbHasUsers ? 'есть' : 'НЕТ!'}`);
        }
      }
    } catch (e) {
      console.log('⚠️ Ошибка проверки текущей БД:', e.message);
    }
  }
  
  const backups = backup.getValidBackups();
  if (backups.length > 0) {
    const latest = backups[0];
    console.log(`📦 Свежий бэкап: ${latest.name} (${latest.mtime.toLocaleString('ru-RU')})`);
  }
  
  if (!dbValid || !dbHasUsers) {
    console.log('🔄 Восстанавливаем из бэкапа...');
    await backup.restoreFromBackup();
  } else {
    console.log('✅ БД валидна, пользователи есть');
  }
  
  console.log('✅ Проверка БД завершена\n');
})();

// ===== АВТОМАТИЧЕСКИЙ БЭКАП КАЖДЫЕ 2 МИНУТЫ (на всякий случай) =====
setInterval(async () => {
  console.log('⏰ Плановый бэкап...');
  await backup.instantBackup('плановый');
}, 2 * 60 * 1000);

// ===== ПРОВЕРКА БД КАЖДУЮ МИНУТУ =====
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
    const header = data.slice(0, 16).toString('hex');
    if (!header.startsWith('53514c69746520666f726d6174')) {
      console.log('⚠️ БД повреждена! Восстанавливаем...');
      await backup.restoreFromBackup();
      return;
    }
  } catch (e) {
    console.log('⚠️ Ошибка проверки БД:', e.message);
  }
}, 60 * 1000);

// ===== БЭКАП ПРИ ВЫХОДЕ =====
process.on('SIGINT', async () => {
  console.log('\n🔄 Мгновенный бэкап перед выходом...');
  await backup.fullBackup();
  console.log('👋 Сервер остановлен');
  process.exit();
});

process.on('SIGTERM', async () => {
  console.log('\n🔄 Мгновенный бэкап перед выходом...');
  await backup.fullBackup();
  console.log('👋 Сервер остановлен');
  process.exit();
});

setTimeout(async () => {
  await backup.instantBackup('старт');
}, 3000);

// ===== ЭКСПОРТ ФУНКЦИИ ДЛЯ ВЫЗОВА ИЗ SERVER.JS =====
module.exports = backup;