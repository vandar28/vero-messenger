const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===== КОНФИГУРАЦИЯ ИЗ .env =====
const TENANT_ID = process.env.EVOLUTION_TENANT_ID;
const ACCESS_KEY_ID = process.env.EVOLUTION_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.EVOLUTION_SECRET_ACCESS_KEY;
const ENDPOINT = process.env.EVOLUTION_ENDPOINT || 'https://s3.cloud.ru';
const BUCKET = process.env.EVOLUTION_BUCKET || 'vero-media';
const PUBLIC_URL = process.env.EVOLUTION_PUBLIC_URL || `${ENDPOINT}/${BUCKET}`;

// Проверяем наличие ключей
const IS_CONFIGURED = !!(ACCESS_KEY_ID && SECRET_ACCESS_KEY);

if (!IS_CONFIGURED) {
  console.warn('⚠️ Evolution Object Storage не настроен! Файлы будут сохраняться локально.');
} else {
  console.log('✅ Evolution Object Storage настроен');
  console.log(`📦 Бакет: ${BUCKET}`);
  console.log(`🔗 Эндпоинт: ${ENDPOINT}`);
}

// ===== СОЗДАНИЕ КЛИЕНТА =====
const s3Client = new S3Client({
  endpoint: ENDPOINT,
  region: 'ru-central-1', // ← ИСПРАВЛЕНО: было 'ru-central1'
  credentials: {
    accessKeyId: ACCESS_KEY_ID || '',
    secretAccessKey: SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true,
});

// ===== ЗАГРУЗКА ФАЙЛА В S3 =====
async function uploadFileToS3(fileBuffer, originalName, mimeType, folder = 'uploads') {
  // Если хранилище не настроено — сохраняем локально
  if (!IS_CONFIGURED) {
    const localPath = path.join(__dirname, 'public', folder, originalName);
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    fs.writeFileSync(localPath, fileBuffer);
    console.log(`📁 Файл сохранен локально: ${localPath}`);
    return `/${folder}/${originalName}`;
  }

  // Генерируем уникальное имя файла
  const fileId = crypto.randomUUID() + '_' + originalName;
  const key = `${folder}/${fileId}`;
  
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType || 'application/octet-stream',
      ACL: 'public-read',
    });
    
    await s3Client.send(command);
    console.log(`✅ Файл загружен в Evolution: ${key}`);
    
    // Возвращаем публичный URL
    return `${PUBLIC_URL}/${key}`;
  } catch (error) {
    console.error('❌ Ошибка загрузки в Evolution:', error);
    // При ошибке сохраняем локально
    const localPath = path.join(__dirname, 'public', folder, originalName);
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    fs.writeFileSync(localPath, fileBuffer);
    console.log(`📁 Файл сохранен локально (ошибка S3): ${localPath}`);
    return `/${folder}/${originalName}`;
  }
}

// ===== УДАЛЕНИЕ ФАЙЛА ИЗ S3 =====
async function deleteFileFromS3(fileUrl) {
  if (!IS_CONFIGURED) {
    const localPath = path.join(__dirname, 'public', fileUrl);
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
      console.log(`🗑️ Локальный файл удален: ${localPath}`);
    }
    return;
  }
  
  try {
    let key = fileUrl;
    if (fileUrl.startsWith('http')) {
      key = fileUrl.split(`${BUCKET}/`)[1];
      if (!key) {
        const urlParts = fileUrl.split('/');
        key = urlParts.slice(urlParts.indexOf(BUCKET) + 1).join('/');
      }
    }
    
    if (!key) {
      console.warn('⚠️ Не удалось извлечь ключ из URL:', fileUrl);
      return;
    }
    
    const command = new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    });
    
    await s3Client.send(command);
    console.log(`🗑️ Файл удален из Evolution: ${key}`);
  } catch (error) {
    console.error('❌ Ошибка удаления из Evolution:', error);
  }
}

// ===== ПОЛУЧЕНИЕ ПРЯМОЙ ССЫЛКИ =====
async function getFileUrl(key, expiresIn = 3600) {
  if (!IS_CONFIGURED) return `/${key}`;
  
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    });
    return await getSignedUrl(s3Client, command, { expiresIn });
  } catch (error) {
    console.error('❌ Ошибка получения подписанной ссылки:', error);
    return null;
  }
}

// ===== ПРОВЕРКА СУЩЕСТВОВАНИЯ ФАЙЛА =====
async function fileExists(key) {
  if (!IS_CONFIGURED) {
    const localPath = path.join(__dirname, 'public', key);
    return fs.existsSync(localPath);
  }
  
  try {
    const command = new HeadObjectCommand({
      Bucket: BUCKET,
      Key: key,
    });
    await s3Client.send(command);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  uploadFileToS3,
  deleteFileFromS3,
  getFileUrl,
  fileExists,
  isConfigured: IS_CONFIGURED,
};