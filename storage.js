const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===== КОНФИГУРАЦИЯ =====
const ACCESS_KEY_ID = process.env.EVOLUTION_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.EVOLUTION_SECRET_ACCESS_KEY;
const ENDPOINT = process.env.EVOLUTION_ENDPOINT || 'https://s3.cloud.ru';
const BUCKET = process.env.EVOLUTION_BUCKET || 'vero-media';

// ===== ПРИНУДИТЕЛЬНЫЙ PUBLIC_URL =====
const PUBLIC_URL = 'https://vero-media.s3.cloud.ru';

const IS_CONFIGURED = !!(ACCESS_KEY_ID && SECRET_ACCESS_KEY);

if (!IS_CONFIGURED) {
  console.warn('⚠️ Evolution Object Storage не настроен!');
} else {
  console.log('✅ Evolution Object Storage настроен');
  console.log(`📦 Бакет: ${BUCKET}`);
  console.log(`🔗 Public URL: ${PUBLIC_URL}`);
}

// ===== КЛИЕНТ =====
const s3Client = new S3Client({
  endpoint: ENDPOINT,
  region: 'ru-central-1',
  credentials: {
    accessKeyId: ACCESS_KEY_ID || '',
    secretAccessKey: SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true,
});

async function uploadFileToS3(fileBuffer, originalName, mimeType, folder = 'uploads') {
  // Сохраняем локально
  const publicPath = path.join(__dirname, 'public', folder, originalName);
  const publicDir = path.dirname(publicPath);
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(publicPath, fileBuffer);
  console.log(`📁 Файл сохранен локально: ${publicPath}`);

  // Пытаемся загрузить в Evolution
  if (IS_CONFIGURED) {
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
      
      // Удаляем локальный файл
      if (fs.existsSync(publicPath)) {
        fs.unlinkSync(publicPath);
        console.log(`🗑️ Локальный файл удален (загружен в Evolution)`);
      }
      
      // ===== ВОЗВРАЩАЕМ ПОЛНЫЙ URL =====
      const fullUrl = `https://vero-media.s3.cloud.ru/${key}`;
      console.log(`📎 URL файла: ${fullUrl}`);
      return fullUrl;
      
    } catch (error) {
      console.error('❌ Ошибка загрузки в Evolution:', error);
      console.log(`📁 Файл оставлен локально: ${publicPath}`);
      return `/${folder}/${originalName}`;
    }
  }
  
  return `/${folder}/${originalName}`;
}

async function deleteFileFromS3(fileUrl) {
  if (fileUrl && !fileUrl.startsWith('http')) {
    const localPath = path.join(__dirname, 'public', fileUrl);
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
      console.log(`🗑️ Локальный файл удален: ${localPath}`);
    }
    return;
  }
  
  if (!IS_CONFIGURED) return;
  
  try {
    let key = fileUrl;
    if (fileUrl.startsWith('http')) {
      // Извлекаем ключ из URL
      const parts = fileUrl.split('/');
      const bucketIndex = parts.indexOf(BUCKET);
      if (bucketIndex !== -1) {
        key = parts.slice(bucketIndex + 1).join('/');
      } else {
        // Если бакет не найден, пробуем другой способ
        const url = new URL(fileUrl);
        key = url.pathname.substring(1);
      }
    }
    if (!key) return;
    
    const command = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
    await s3Client.send(command);
    console.log(`🗑️ Файл удален из Evolution: ${key}`);
  } catch (error) {
    console.error('❌ Ошибка удаления из Evolution:', error);
  }
}

async function getFileUrl(key, expiresIn = 3600) {
  if (!IS_CONFIGURED) return `/${key}`;
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return await getSignedUrl(s3Client, command, { expiresIn });
  } catch (error) {
    console.error('❌ Ошибка получения подписанной ссылки:', error);
    return null;
  }
}

async function fileExists(key) {
  if (!IS_CONFIGURED) {
    const localPath = path.join(__dirname, 'public', key);
    return fs.existsSync(localPath);
  }
  try {
    const command = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
    await s3Client.send(command);
    return true;
  } catch { return false; }
}

module.exports = {
  uploadFileToS3,
  deleteFileFromS3,
  getFileUrl,
  fileExists,
  isConfigured: IS_CONFIGURED,
};