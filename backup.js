const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const zlib = require('zlib');
const crypto = require('crypto');

class DatabaseBackup {
  constructor() {
    this.dbPath = path.join(__dirname, 'database.sqlite');
    this.backupDir = path.join(__dirname, 'backups');
    this.tempDir = path.join(__dirname, 'temp_backups');
    this.maxBackups = 16; // Храним только 16 последних бэкапов
    
    // Создаем папки если их нет
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    
    console.log('📁 Папки для бэкапов созданы');
  }

  // Проверка размера БД
  getDatabaseSize() {
    if (!fs.existsSync(this.dbPath)) return 0;
    const stats = fs.statSync(this.dbPath);
    return stats.size;
  }

  // Создание сжатого бэкапа
  createBackup() {
    if (!fs.existsSync(this.dbPath)) {
      console.log('❌ База данных не найдена');
      return null;
    }

    const sizeMB = (this.getDatabaseSize() / 1024 / 1024).toFixed(2);
    console.log(`📊 Текущий размер БД: ${sizeMB} MB`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}.sqlite.gz`;
    const backupPath = path.join(this.backupDir, backupName);
    
    try {
      // Читаем БД
      const data = fs.readFileSync(this.dbPath);
      
      // Сжимаем с максимальным уровнем сжатия
      const compressed = zlib.gzipSync(data, { level: 9 });
      
      // Сохраняем сжатый бэкап
      fs.writeFileSync(backupPath, compressed);
      
      const originalSize = (data.length / 1024 / 1024).toFixed(2);
      const compressedSize = (compressed.length / 1024 / 1024).toFixed(2);
      const savedPercent = ((1 - compressedSize / originalSize) * 100).toFixed(0);
      
      console.log(`✅ Бэкап создан: ${backupName}`);
      console.log(`📦 ${originalSize} MB → ${compressedSize} MB (экономия ${savedPercent}%)`);
      
      return backupPath;
    } catch (error) {
      console.error('❌ Ошибка создания бэкапа:', error);
      return null;
    }
  }

  // Очистка старых бэкапов (оставляем только 16 последних)
  cleanOldBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'))
        .sort();
      
      console.log(`📁 Найдено бэкапов: ${files.length}`);
      
      if (files.length <= this.maxBackups) {
        console.log(`✅ Всего ${files.length} бэкапов (лимит ${this.maxBackups})`);
        return;
      }
      
      // Удаляем самые старые
      const toDelete = files.slice(0, files.length - this.maxBackups);
      let deleted = 0;
      
      for (const file of toDelete) {
        const filePath = path.join(this.backupDir, file);
        fs.unlinkSync(filePath);
        deleted++;
        console.log(`🗑️ Удален старый бэкап: ${file}`);
      }
      
      console.log(`✅ Очищено ${deleted} старых бэкапов. Осталось ${this.maxBackups}`);
    } catch (error) {
      console.error('❌ Ошибка очистки бэкапов:', error);
    }
  }

  // Синхронизация с GitHub через git
  syncToGitHub() {
    return new Promise((resolve, reject) => {
      console.log('📤 Отправка бэкапов в GitHub...');
      
      // Добавляем бэкапы в git
      exec('git add backups/', (error, stdout, stderr) => {
        if (error) {
          console.log('⚠️ git add:', stderr);
          // Продолжаем даже если ошибка
        }
        
        // Проверяем есть ли изменения
        exec('git status --porcelain', (err, status) => {
          if (err) {
            console.log('⚠️ git status error:', err.message);
            // Пробуем коммитить все равно
          }
          
          // Если есть изменения - коммитим
          if (status && status.trim()) {
            const message = `Auto backup: ${new Date().toISOString()}`;
            exec(`git commit -m "${message}"`, (err2) => {
              if (err2) {
                console.log('⚠️ git commit:', err2.message);
                // Продолжаем даже если ошибка
              }
              
              // Пушим
              exec('git push origin main', (err3) => {
                if (err3) {
                  console.log('⚠️ git push error:', err3.message);
                  // Пробуем с force push если нужно
                  exec('git push origin main --force', (err4) => {
                    if (err4) {
                      console.error('❌ Ошибка отправки в GitHub:', err4.message);
                      reject(err4);
                    } else {
                      console.log('✅ Бэкапы отправлены в GitHub (force)');
                      resolve();
                    }
                  });
                } else {
                  console.log('✅ Бэкапы отправлены в GitHub');
                  resolve();
                }
              });
            });
          } else {
            console.log('ℹ️ Нет изменений для коммита');
            resolve();
          }
        });
      });
    });
  }

  // Полный процесс бэкапа
  async fullBackup() {
    console.log('\n🔄 Начинаем процесс бэкапа...');
    
    // 1. Создаем бэкап
    const backupPath = this.createBackup();
    if (!backupPath) {
      console.log('❌ Бэкап не создан');
      return false;
    }
    
    // 2. Очищаем старые бэкапы
    this.cleanOldBackups();
    
    // 3. Отправляем в GitHub
    try {
      await this.syncToGitHub();
      console.log('✅ Процесс бэкапа завершен успешно\n');
      return true;
    } catch (error) {
      console.error('❌ Ошибка синхронизации с GitHub:', error);
      console.log('⚠️ Бэкап сохранен локально, но не отправлен в GitHub');
      return false;
    }
  }

  // Восстановление из последнего бэкапа (локально)
  restoreLatestBackup() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'))
        .sort();
      
      if (files.length === 0) {
        console.log('ℹ️ Нет локальных бэкапов для восстановления');
        return false;
      }
      
      const latest = files[files.length - 1];
      const backupPath = path.join(this.backupDir, latest);
      
      console.log(`📥 Восстановление из бэкапа: ${latest}`);
      
      // Распаковываем
      const compressed = fs.readFileSync(backupPath);
      const data = zlib.gunzipSync(compressed);
      fs.writeFileSync(this.dbPath, data);
      
      console.log(`✅ База данных восстановлена! Размер: ${(data.length / 1024 / 1024).toFixed(2)} MB`);
      return true;
    } catch (error) {
      console.error('❌ Ошибка восстановления:', error);
      return false;
    }
  }

  // Восстановление из GitHub (при старте)
  async restoreFromGitHub() {
    console.log('🔄 Проверка бэкапов в GitHub...');
    
    return new Promise((resolve) => {
      // Пытаемся получить последние изменения из GitHub
      exec('git pull origin main', (error, stdout, stderr) => {
        if (error) {
          console.log('⚠️ Не удалось обновить репозиторий:', error.message);
          // Пробуем восстановить из локальных бэкапов
          const restored = this.restoreLatestBackup();
          resolve(restored);
          return;
        }
        
        console.log('📥 Репозиторий обновлен');
        
        // Проверяем наличие бэкапов
        if (!fs.existsSync(this.backupDir)) {
          console.log('ℹ️ Нет бэкапов для восстановления');
          resolve(false);
          return;
        }
        
        const files = fs.readdirSync(this.backupDir)
          .filter(f => f.startsWith('backup-') && f.endsWith('.sqlite.gz'));
        
        if (files.length === 0) {
          console.log('ℹ️ Нет бэкапов для восстановления');
          resolve(false);
          return;
        }
        
        // Восстанавливаем последний бэкап
        const restored = this.restoreLatestBackup();
        resolve(restored);
      });
    });
  }
}

// Создаем экземпляр
const backup = new DatabaseBackup();

// Автоматический бэкап каждые 10 минут
setInterval(() => {
  backup.fullBackup();
}, 10 * 60 * 1000);

// Бэкап при выходе
process.on('SIGINT', () => {
  console.log('\n🔄 Бэкап перед выходом...');
  backup.fullBackup().then(() => {
    console.log('👋 Сервер остановлен');
    process.exit();
  });
});

process.on('SIGTERM', () => {
  console.log('\n🔄 Бэкап перед выходом...');
  backup.fullBackup().then(() => {
    console.log('👋 Сервер остановлен');
    process.exit();
  });
});

// Делаем бэкап через 5 секунд после старта
setTimeout(() => {
  backup.fullBackup();
}, 5000);

module.exports = backup;