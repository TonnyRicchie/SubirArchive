const TelegramBot = require('node-telegram-bot-api');
const stream = require('stream');
const { promisify } = require('util');
const fetch = require('node-fetch');
const FormData = require('form-data');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InternetArchive } = require('internetarchive-sdk-js');
const pipeline = require('stream/promises').pipeline;

// Configuracion mejorada del agente HTTPS
const httpsAgent = new https.Agent({
    keepAlive: true,
    timeout: 60000,
    rejectUnauthorized: false
});

const token = '7689801831:AAFZJo9lJQgWUkB6fNHfqq2j-8-OjfA7mWY';

// Configuracion simplificada del bot
const bot = new TelegramBot(token, {
    polling: {
        interval: 2000,
        autoStart: true,
        params: {
            timeout: 10
        }
    },
    request: {
        timeout: 60000,
        agent: httpsAgent,
    },
    baseApiUrl: "https://api.telegram.org"
});

const sessions = {};
const uploadData = {};
const States = {
    IDLE: 'IDLE',
    AWAITING_ACCESS_KEY: 'AWAITING_ACCESS_KEY',
    AWAITING_SECRET_KEY: 'AWAITING_SECRET_KEY',
    AWAITING_FILE: 'AWAITING_FILE',
    AWAITING_TITLE: 'AWAITING_TITLE',
    AWAITING_DESCRIPTION: 'AWAITING_DESCRIPTION',
    AWAITING_COLLECTION: 'AWAITING_COLLECTION',
    UPLOADING: 'UPLOADING',
    AWAITING_RENAME: 'AWAITING_RENAME',
    EDITING_TITLE: 'EDITING_TITLE',
    EDITING_DESCRIPTION: 'EDITING_DESCRIPTION',
    EDITING_COLLECTION: 'EDITING_COLLECTION',
    ADDING_FILE_TO_EXISTING: 'ADDING_FILE_TO_EXISTING',
    AWAITING_NEW_FILE_URL: 'AWAITING_NEW_FILE_URL',
    AWAITING_NEW_FILE_NAME: 'AWAITING_NEW_FILE_NAME'
};

let userStates = {};
let lastUpdateTime = {};

const urlRegex = /^(https?:\/\/[^\s]+)$/;

// Sistema de reconexion mejorado
let reconnectTimeout;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectAttempts = 0;

bot.on('polling_error', async (error) => {
    console.log('Error de conexion detectado:', error.message);
    try {
        await bot.stopPolling();
        await new Promise(resolve => setTimeout(resolve, 5000));
        await bot.startPolling();
        console.log('Reconexion exitosa');
    } catch (err) {
        console.error('Error al reconectar:', err.message);
    }
});

// Mantener conexion activa
setInterval(() => {
    bot.getMe().catch(error => {
        console.log('Error de conexion, reconectando...');
        bot.stopPolling().then(() => bot.startPolling());
    });
}, 60000);

// Manejador de errores mejorado
bot.on('error', (error) => {
    console.log('Error general del bot:', error.message);
});

// Mantener el bot vivo
setInterval(() => {
    try {
        bot.getMe().catch(error => {
            console.log('Error en keepalive, intentando reconectar...');
            bot.stopPolling().then(() => bot.startPolling());
        });
    } catch (error) {
        console.error('Error en el intervalo de keepalive:', error);
    }
}, 30000);

function formatTime(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}m ${secs}s`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

function formatProgressBar(progress, total) {
    const width = 20;
    const filled = Math.floor((progress / total) * width);
    return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function formatProgress(progress, total, startTime, isDownload = false) {
    const percent = (progress / total * 100).toFixed(1);
    const downloaded = (progress / (1024 * 1024)).toFixed(2);
    const totalSize = (total / (1024 * 1024)).toFixed(2);
    
    const elapsedTime = (Date.now() - startTime) / 1000;
    const speed = progress / elapsedTime;
    const speedMB = (speed / (1024 * 1024)).toFixed(2);
    const remaining = (total - progress) / speed;
    
    let progressText = '';
    
    if (isDownload) {
        progressText = `${formatProgressBar(progress, total)}\n`;
    }
    
    return progressText +
           `📊 Progreso: ${percent}%\n` +
           `💾 ${downloaded}MB / ${totalSize}MB\n` +
           `🚀 Velocidad: ${speedMB} MB/s\n` +
           `⏱️ Tiempo: ${formatTime(elapsedTime)}\n` +
           `⏳ Restante: ${formatTime(remaining)}`;
}

async function updateProgressMessage(chatId, messageId, progress, total, action = 'Descargando') {
    try {
        const now = Date.now();
        if (lastUpdateTime[chatId] && now - lastUpdateTime[chatId] < 2000) {
            return;
        }

        if (!uploadData[chatId].startTime) {
            uploadData[chatId].startTime = now;
        }

        const isDownload = action === 'Descargando';
        const progressText = `⏳ ${action}...\n\n${formatProgress(progress, total, uploadData[chatId].startTime, isDownload)}`;
        
        await bot.editMessageText(progressText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML'
        }).catch(error => {
            if (!error.message.includes('message is not modified') && 
                !error.message.includes('message to edit not found') &&
                !error.message.includes('429')) {
                console.log('Error en actualizacion:', error.message);
            }
        });
        
        lastUpdateTime[chatId] = now;
    } catch (error) {
        console.log('Error en actualizacion de progreso:', error.message);
    }
}

async function uploadToArchive(chatId, messageId) {
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `download_${Date.now()}`);
    let readStream = null;
    
    try {
        const { fileUrl, fileName, title, description, collection } = uploadData[chatId];

        // Mensaje inicial
        await bot.editMessageText(
            '🔄 Iniciando proceso...\n' +
            '⬇️ Preparando descarga...',
            {
                chat_id: chatId,
                message_id: messageId
            }
        );

        // Crear write stream para archivo temporal
        const fileStream = fs.createWriteStream(tempFilePath);
        
        const response = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) throw new Error('Error al obtener el archivo');

        const totalSize = parseInt(response.headers.get('content-length'));
        let downloadProgress = 0;
        
        // Stream de progreso para la descarga
        const downloadProgressStream = new stream.Transform({
            transform(chunk, encoding, callback) {
                downloadProgress += chunk.length;
                const now = Date.now();
                if (!lastUpdateTime[chatId] || now - lastUpdateTime[chatId] > 2000) {
                    updateProgressMessage(chatId, messageId, downloadProgress, totalSize, 'Descargando')
                        .catch(() => {});
                    lastUpdateTime[chatId] = now;
                }
                callback(null, chunk);
            }
        });

        // Descargar archivo usando pipeline
        await pipeline(
            response.body,
            downloadProgressStream,
            fileStream
        );

        // Cerrar explicitamente el fileStream
        await new Promise((resolve, reject) => {
            fileStream.end(() => resolve());
        });

        // Mensaje de inicio de subida
        await bot.editMessageText(
            '📤 Preparando subida a Archive.org...',
            {
                chat_id: chatId,
                message_id: messageId
            }
        );

        // Generar identificador Ãºnico
        const identifier = `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;

        // Configurar subida
        let uploadProgress = 0;
        const fileSize = fs.statSync(tempFilePath).size;

        // Stream de progreso para la subida
        const uploadProgressStream = new stream.Transform({
            transform(chunk, encoding, callback) {
                uploadProgress += chunk.length;
                const now = Date.now();
                if (!lastUpdateTime[chatId] || now - lastUpdateTime[chatId] > 2000) {
                    updateProgressMessage(chatId, messageId, uploadProgress, fileSize, 'Subiendo')
                        .catch(() => {});
                    lastUpdateTime[chatId] = now;
                }
                callback(null, chunk);
            }
        });

        // Crear read stream para subida
        readStream = fs.createReadStream(tempFilePath, { highWaterMark: 1024 * 1024 }); 

        // Subir a Archive.org
        const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
            method: 'PUT',
            headers: {
                'Authorization': `LOW ${sessions[chatId].accessKey}:${sessions[chatId].secretKey}`,
                'Content-Type': 'video/mp4',
                'Content-Length': fileSize.toString(),
                'x-archive-queue-derive': '0',
                'x-archive-auto-make-bucket': '1',
                'x-archive-meta-mediatype': 'movies',
                'x-archive-size-hint': fileSize.toString(),
                'x-archive-meta-title': title,
                'x-archive-meta-description': description || '',
                'x-archive-meta-collection': collection
            },
            body: readStream.pipe(uploadProgressStream),
            duplex: 'half'
        });

        if (!uploadResponse.ok) {
            throw new Error(`Error en la subida: ${await uploadResponse.text()}`);
        }

        // Mensaje de finalización (mantenemos el original)
        await bot.editMessageText(
            '✅ Archivo subido correctamente\n' +
            '⏳ Procesando en Archive.org...',
            {
                chat_id: chatId,
                message_id: messageId
            }
        );

        // Esperar procesamiento
        await new Promise(resolve => setTimeout(resolve, 15000));

        // Obtener URL del stream
        const directUrl = await getCorrectStreamUrl(identifier, fileName);
        
        // Eliminar el mensaje de procesamiento
await bot.deleteMessage(chatId, messageId);

if (directUrl) {
    await bot.sendMessage(chatId,
        '✅ ¡Archivo subido y procesado exitosamente!\n\n' +
        `📋 Página: https://archive.org/details/${identifier}\n` +
        `🎬 Stream directo: ${directUrl}\n` +
        `⬇️ Descarga: https://archive.org/download/${identifier}/${fileName}\n\n` +
        '⏳ Nota: La página puede tardar unos minutos en estar completamente disponible.'
    );
    return true; // Retornar true después de éxito
} else {
    await bot.sendMessage(chatId,
        '✅ ¡Archivo subido exitosamente!\n\n' +
        `📋 Página: https://archive.org/details/${identifier}\n` +
        `⬇️ Descarga: https://archive.org/download/${identifier}/${fileName}\n\n` +
        '⚠️ La URL de stream estará disponible en unos minutos.\n' +
        '📝 Puedes usar /edit más tarde para ver todas las URLs.'
    );
    return true; // Retornar true incluso si no hay URL de stream
}
} catch (error) {
        console.error('Error completo:', error);
        await bot.sendMessage(chatId, '❌ Error en la subida: ' + error.message);
        throw error;
    } finally {
        // Cerrar streams explÃ­citamente
        if (readStream) {
            readStream.destroy();
        }
        
        // Limpiar archivo temporal
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch (error) {
            console.error('Error al eliminar archivo temporal:', error);
        }
        
        delete lastUpdateTime[chatId];
        userStates[chatId] = States.IDLE;
        delete uploadData[chatId];
    }
}

async function getCorrectStreamUrl(identifier, fileName, maxWaitTime = 30000) { // 30 segundos máximo
    const startTime = Date.now();
    const checkInterval = 5000; // Verificar cada 5 segundos

    while (Date.now() - startTime < maxWaitTime) {
        try {
            const response = await fetch(`https://archive.org/metadata/${identifier}`);
            const data = await response.json();
            
            if (data && data.d1 && data.dir && data.files) {
                const file = data.files.find(f => f.name === fileName);
                if (file) {
                    // Si encontramos la URL, retornar inmediatamente
                    return `https://${data.d1}${data.dir}/${fileName}`;
                }
            }

            // Si no encontramos la URL, esperar antes del siguiente intento
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            
        } catch (error) {
            console.error('Error al verificar URL:', error);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
    }

    return null;
}

async function handleAccessKey(msg) {
    const chatId = msg.chat.id;
    const accessKey = msg.text.trim();
    
    if (accessKey.length < 1) {
        bot.sendMessage(chatId, '❌ Access Key inválida. No puede estar vacía.');
        return;
    }
    
    sessions[chatId] = { accessKey };
    userStates[chatId] = States.AWAITING_SECRET_KEY;
    bot.sendMessage(chatId, '🔐 Ahora envía tu Secret Key');
}

async function handleSecretKey(msg) {
    const chatId = msg.chat.id;
    const secretKey = msg.text.trim();

    if (secretKey.length < 1) {
        return bot.sendMessage(chatId, '❌ Secret Key inválida. No puede estar vacía.');
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

     // Obtener información de la cuenta
        const accountResponse = await fetch('https://s3.us.archive.org', {
            method: 'GET',
            headers: {
                'Authorization': `LOW ${sessions[chatId].accessKey}:${secretKey}`
            },
            signal: controller.signal,
            agent: new https.Agent({
                rejectUnauthorized: true,
                keepAlive: true,
                timeout: 10000
            })
        }).finally(() => clearTimeout(timeout));

        if (accountResponse.ok) {
            const accountData = await accountResponse.text();
            const displayNameMatch = accountData.match(/<DisplayName>(.+?)<\/DisplayName>/);
            const username = displayNameMatch ? displayNameMatch[1] : 'Usuario';

            sessions[chatId].secretKey = secretKey;
            sessions[chatId].username = username; // Guardar el nombre de usuario
            userStates[chatId] = States.IDLE;

            await bot.sendMessage(chatId, 
                `✅ ¡Login exitoso ${username}!\n\n` +
                `🔑 Access Key: ${sessions[chatId].accessKey}\n` +
                '🎥 Ahora puedes enviar videos o usar /upload para subir por URL\n' +
                '📝 Usa /edit para gestionar tus uploads'
            );
        } else {
            throw new Error('Credenciales inválidas');
        }
    } catch (error) {
        delete sessions[chatId];
        let errorMessage = '❌ Error en el login. ';
        
        if (error.name === 'AbortError') {
            errorMessage += 'La conexión tardó más de 10 segundos. ';
        } else if (error.code === 'ECONNRESET' || error.code === 'EFATAL') {
            errorMessage += 'Error de conexión. ';
        }
        
        errorMessage += 'Por favor, verifica tu conexion e intenta nuevamente con /login';
        
        await bot.sendMessage(chatId, errorMessage);
        console.error('Error de login:', error);
    }
}

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        '🎴 Bienvenido al Bot de Archive.org\n\n' +
        'Para subir archivos grandes (hasta 2GB):\n' +
        '1. Sube tu archivo a un servicio de almacenamiento\n' +
        '2. Copia la URL directa de descarga\n' +
        '3. Envía la URL al bot\n\n' +
        'Comandos:\n' +
        '/login - Iniciar sesión\n' +
        '/logout - Cerrar sesión\n' +
        '/status - Ver estado\n' +
        '/upload - Iniciar subida por URL\n' +
        '/edit - Editar tus uploads y agregar archivos\n' +
        '/buckets - Ver tus buckets S3\n\n' +
        'Obtén tus credenciales en:\n' +
        'https://archive.org/account/s3.php'
    );
});

bot.onText(/\/edit/, async (msg) => {
    const chatId = msg.chat.id;
    if (!sessions[chatId]) {
        return bot.sendMessage(chatId, '❌ Primero debes iniciar sesión con /login');
    }

    try {
        const waitMessage = await bot.sendMessage(chatId, '🔍 Buscando todos tus uploads...');

        // Búsqueda por Access Key (S3)
        const s3SearchUrl = `https://archive.org/advancedsearch.php?q=uploader:(${encodeURIComponent(sessions[chatId].accessKey)})&fl[]=identifier,title,description,collection,addeddate,uploader,source,creator,name&sort[]=addeddate+desc&output=json&rows=1000`;
        
        // Búsqueda por nombre de usuario
        const userSearchUrl = `https://archive.org/advancedsearch.php?q=uploader:(${encodeURIComponent(sessions[chatId].username)})&fl[]=identifier,title,description,collection,addeddate,uploader,source,creator,name&sort[]=addeddate+desc&output=json&rows=1000`;

        // Búsqueda por buckets
        const bucketsResponse = await fetch('https://s3.us.archive.org', {
            method: 'GET',
            headers: {
                'Authorization': `LOW ${sessions[chatId].accessKey}:${sessions[chatId].secretKey}`
            }
        });

        const bucketsData = await bucketsResponse.text();
        const bucketNames = Array.from(bucketsData.matchAll(/<Name>(.+?)<\/Name>/g))
            .map(match => match[1]);

        // Realizar todas las búsquedas
        const [s3Results, userResults] = await Promise.all([
            fetch(s3SearchUrl).then(r => r.json()),
            fetch(userSearchUrl).then(r => r.json())
        ]);

        // Combinar resultados
        const allItems = new Map();

        // Agregar resultados de S3
        s3Results.response?.docs?.forEach(item => {
            allItems.set(item.identifier, item);
        });

        // Agregar resultados de usuario
        userResults.response?.docs?.forEach(item => {
            allItems.set(item.identifier, item);
        });

        // Agregar buckets como items si no estan ya incluidos
        bucketNames.forEach(bucket => {
            if (!allItems.has(bucket)) {
                allItems.set(bucket, {
                    identifier: bucket,
                    title: bucket,
                    uploader: sessions[chatId].username
                });
            }
        });

        const uniqueItems = Array.from(allItems.values());

        if (uniqueItems.length > 0) {
            let message = `📚 Uploads de ${sessions[chatId].username}:\n\n`;
            const keyboard = [];

            uniqueItems.forEach((item, index) => {
                const title = item.title || item.identifier;
                const displayTitle = title.length > 30 ? title.substring(0, 27) + '...' : title;
                
                message += `${index + 1}. 🌐 ${title}\n`;
                keyboard.push([{
                    text: `🌐 ${displayTitle}`,
                    callback_data: `edit_${item.identifier}`
                }]);
            });

            await bot.deleteMessage(chatId, waitMessage.message_id);

            // Dividir mensaje si es muy largo
            if (message.length > 4096) {
                for (let i = 0; i < message.length; i += 4096) {
                    await bot.sendMessage(chatId, message.slice(i, i + 4096));
                }
            } else {
                await bot.sendMessage(chatId, message);
            }

            // Enviar teclado en grupos de 8 botones
            const buttonsPerMessage = 8;
            for (let i = 0; i < keyboard.length; i += buttonsPerMessage) {
                const keyboardChunk = keyboard.slice(i, i + buttonsPerMessage);
                await bot.sendMessage(chatId, 
                    i === 0 ? '🔍 Selecciona un item para editar:' : '📑 Más items:',
                    {
                        reply_markup: {
                            inline_keyboard: keyboardChunk
                        }
                    }
                );
            }

        } else {
            await bot.deleteMessage(chatId, waitMessage.message_id);
            await bot.sendMessage(chatId, 
                '❌ No se encontraron uploads asociados a tu cuenta.\n\n' +
                'Nota: Los uploads pueden tardar en aparecer:\n' +
                '- Uploads recientes: 5-30 minutos\n' +
                'Si acabas de subir contenido, espera unos minutos y vuelve a intentar.'
            );
        }
    } catch (error) {
        console.error('Error completo:', error);
        await bot.sendMessage(chatId, 
            '❌ Error al buscar uploads: ' + error.message + '\n' +
            'Por favor, intenta de nuevo en unos momentos.'
        );
    }
});

bot.onText(/\/buckets/, async (msg) => {
    const chatId = msg.chat.id;
    if (!sessions[chatId]) {
        return bot.sendMessage(chatId, '❌ Primero debes iniciar sesión con /login');
    }

    try {
        const waitMessage = await bot.sendMessage(chatId, '🔍 Buscando tus buckets S3...');

        const response = await fetch('https://s3.us.archive.org', {
            method: 'GET',
            headers: {
                'Authorization': `LOW ${sessions[chatId].accessKey}:${sessions[chatId].secretKey}`
            }
        });

        const data = await response.text();
        const buckets = Array.from(data.matchAll(/<Bucket><Name>(.+?)<\/Name><CreationDate>(.+?)<\/CreationDate><\/Bucket>/g))
            .map(match => ({
                name: match[1],
                creationDate: match[2]
            }));

        if (buckets.length > 0) {
            let message = `📦 Tus Buckets S3:\n\n`;
            const keyboard = [];

            buckets.forEach((bucket, index) => {
                const creationDate = new Date(bucket.creationDate).toLocaleDateString();
                message += `${index + 1}. 📦 ${bucket.name}\n`;
                keyboard.push([{
                    text: `📦 ${bucket.name}`,
                    callback_data: `bucket_info_${bucket.name}`
                }]);
            });

await bot.deleteMessage(chatId, waitMessage.message_id);
            await bot.sendMessage(chatId, message);

            const buttonsPerMessage = 8;
            for (let i = 0; i < keyboard.length; i += buttonsPerMessage) {
                const keyboardChunk = keyboard.slice(i, i + buttonsPerMessage);
                await bot.sendMessage(chatId, 
                    i === 0 ? '🔍 Selecciona un bucket para ver sus detalles:' : '📑 Más buckets:',
                    {
                        reply_markup: {
                            inline_keyboard: keyboardChunk
                        }
                    }
                );
            }
        } else {
            await bot.deleteMessage(chatId, waitMessage.message_id);
            await bot.sendMessage(chatId, '❌ No se encontraron buckets S3 en tu cuenta.');
        }
    } catch (error) {
        console.error('Error completo:', error);
        await bot.sendMessage(chatId, 
            '❌ Error al buscar buckets: ' + error.message + '\n' +
            'Por favor, intenta de nuevo en unos momentos.'
        );
    }
});

// Manejador para mostrar información detallada del bucket
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    if (data.startsWith('bucket_info_')) {
        const bucketName = data.replace('bucket_info_', '');
        try {
            // Obtener metadata del bucket
            const metadataResponse = await fetch(`https://archive.org/metadata/${bucketName}`);
            const metadata = await metadataResponse.json();

            let message = `📦 Información del Bucket: ${bucketName}\n\n`;

            if (metadata && metadata.metadata) {
                message += `📝 Título: ${metadata.metadata.title || 'No disponible'}\n`;
                message += `📋 Descripción: ${metadata.metadata.description || 'No disponible'}\n`;
                message += `📚 Colección: ${metadata.metadata.collection || 'No disponible'}\n`;
                message += `👤 Creador: ${metadata.metadata.creator || 'No disponible'}\n`;
                message += `📅 Fecha de creación: ${metadata.metadata.date || 'No disponible'}\n`;
                message += `🔄 Última actualización: ${metadata.metadata.updatedate || 'No disponible'}\n`;
                
                if (metadata.files && metadata.files.length > 0) {
                    message += `\n📁 Archivos en el bucket: ${metadata.files.length}\n`;
                    let totalSize = 0;
                    metadata.files.forEach(file => {
                        totalSize += parseInt(file.size) || 0;
                    });
                    message += `💾 Tamaño total: ${(totalSize / (1024 * 1024)).toFixed(2)} MB\n`;
                }
            } else {
                message += '❌ No se encontró información adicional del bucket.\n';
            }

            message += `\n🔗 URL: https://archive.org/details/${bucketName}`;

            await bot.sendMessage(chatId, message);
        } catch (error) {
            console.error('Error al obtener información del bucket:', error);
            await bot.sendMessage(chatId, '❌ Error al obtener información del bucket.');
        }
    }
});

bot.onText(/\/upload/, (msg) => {
    const chatId = msg.chat.id;
    if (!sessions[chatId]) {
        return bot.sendMessage(chatId, '❌ Primero debes iniciar sesión con /login');
    }
    userStates[chatId] = States.AWAITING_FILE;
    bot.sendMessage(chatId, 
        '🔗 Envía la URL directa del archivo de video\n' +
        'Ejemplo: https://ejemplo.com/video.mp4\n' +
        'El archivo debe ser menor a 2GB'
    );
});

bot.onText(/\/login/, (msg) => {
    const chatId = msg.chat.id;
    if (sessions[chatId]) {
        return bot.sendMessage(chatId, '❌ Ya tienes una sesión activa. Usa /logout primero si quieres cambiar de cuenta.');
    }
    userStates[chatId] = States.AWAITING_ACCESS_KEY;
    bot.sendMessage(chatId, '🔑 Por favor, envía tu Access Key de Archive.org S3');
});

bot.onText(/\/logout/, (msg) => {
    const chatId = msg.chat.id;
    if (sessions[chatId]) {
        delete sessions[chatId];
        userStates[chatId] = States.IDLE;
        bot.sendMessage(chatId, '✅ Sesión cerrada exitosamente');
    } else {
        bot.sendMessage(chatId, '❌ No hay sesión activa');
    }
});

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    if (sessions[chatId]) {
        bot.sendMessage(chatId, `🔷 Sesión activa con Access Key: ${sessions[chatId].accessKey}`);
    } else {
        bot.sendMessage(chatId, '❌ No hay sesión activa');
    }
});

async function handleFileUrl(msg) {
    const chatId = msg.chat.id;
    const url = msg.text;

    try {
        const statusMessage = await bot.sendMessage(chatId, '🔍 Verificando enlace...');
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error('No se puede acceder al archivo');
        }

        const contentLength = response.headers.get('content-length');
        const contentType = response.headers.get('content-type');

        let fileName = url.split('/').pop().split('?')[0] || 'video.mp4';
        if (!fileName.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i)) {
            fileName += '.mp4';
        }

        uploadData[chatId] = {
            fileUrl: url,
            fileName: fileName,
            mimeType: contentType || 'video/mp4',
            fileSize: contentLength ? parseInt(contentLength) : null,
            statusMessageId: statusMessage.message_id
        };

        await bot.editMessageText(
            `✅ Enlace verificado\n\n` +
            `📁 Nombre: ${fileName}\n` +
            `💾 Tamaño: ${contentLength ? (parseInt(contentLength) / (1024 * 1024)).toFixed(2) + ' MB' : 'Desconocido'}`,
            {
                chat_id: chatId,
                message_id: statusMessage.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{text: '✏️ Renombrar archivo', callback_data: 'rename_file'}],
                        [{text: '✅ Continuar', callback_data: 'continue_upload'}]
                    ]
                }
            }
        );
    } catch (error) {
        await bot.sendMessage(chatId, '❌ Error con la URL: ' + error.message);
    }
}

async function handleEditItem(chatId, identifier) {
    try {
        const response = await fetch(`https://archive.org/metadata/${identifier}`);
        const metadata = await response.json();
        
        if (metadata && metadata.metadata) {
            const files = metadata.files || [];
            const videoFiles = files.filter(file => 
                file.name.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i)
            );

            let message = 
                `📝 Detalles del item:\n\n` +
                `📌 Título: ${metadata.metadata.title || 'No disponible'}\n` +
                `🔍 ID: ${identifier}\n` +
                `📚 Colección: ${metadata.metadata.collection || 'No disponible'}\n` +
                `📝 Descripción: ${metadata.metadata.description || 'No disponible'}\n\n` +
                `📁 Archivos actuales: ${videoFiles.length}\n`;

            videoFiles.forEach(file => {
                message += `▫️ ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)\n`;
            });

            message += '\n¿Qué deseas hacer?';

            const keyboard = [
                [{text: '✏️ Editar Título', callback_data: `edit_title_${identifier}`}],
                [{text: '📝 Editar Descripción', callback_data: `edit_desc_${identifier}`}],
                [{text: '📚 Editar Colección', callback_data: `edit_coll_${identifier}`}],
                [{text: '📤 Agregar Nuevo Archivo', callback_data: `add_file_${identifier}`}],
                [{text: '🔙 Volver', callback_data: 'back_to_list'}]
            ];

            await bot.sendMessage(chatId, message, {
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
        } else {
            throw new Error('No se pudo obtener la informacion del item');
        }
    } catch (error) {
        console.error('Error al obtener detalles:', error);
        await bot.sendMessage(chatId, '❌ Error al obtener detalles del item');
    }
}

async function addFileToExisting(chatId, identifier, fileUrl, fileName) {
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `download_${Date.now()}`);
    let readStream = null;

    try {
        const statusMessage = await bot.sendMessage(chatId, '⏳ Iniciando descarga del nuevo archivo...');

        // Crear write stream para archivo temporal
        const fileStream = fs.createWriteStream(tempFilePath);
        
        const response = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) throw new Error('Error al obtener el archivo');

        const totalSize = parseInt(response.headers.get('content-length'));
        let downloadProgress = 0;

        // Stream de progreso para la descarga
        const downloadProgressStream = new stream.Transform({
            transform(chunk, encoding, callback) {
                downloadProgress += chunk.length;
                const now = Date.now();
                if (!lastUpdateTime[chatId] || now - lastUpdateTime[chatId] > 2000) {
                    updateProgressMessage(chatId, statusMessage.message_id, downloadProgress, totalSize, 'Descargando')
                        .catch(() => {});
                    lastUpdateTime[chatId] = now;
                }
                callback(null, chunk);
            }
        });

        // Descargar archivo usando pipeline
        await pipeline(
            response.body,
            downloadProgressStream,
            fileStream
        );

        // Cerrar explicitamente el fileStream
        await new Promise((resolve, reject) => {
            fileStream.end(() => resolve());
        });

        // Preparar subida
        let uploadProgress = 0;
        const fileSize = fs.statSync(tempFilePath).size;

        // Stream de progreso para la subida
        const uploadProgressStream = new stream.Transform({
            transform(chunk, encoding, callback) {
                uploadProgress += chunk.length;
                const now = Date.now();
                if (!lastUpdateTime[chatId] || now - lastUpdateTime[chatId] > 2000) {
                    updateProgressMessage(chatId, statusMessage.message_id, uploadProgress, fileSize, 'Subiendo')
                        .catch(() => {});
                    lastUpdateTime[chatId] = now;
                }
                callback(null, chunk);
            }
        });

        // Crear read stream para subida
        readStream = fs.createReadStream(tempFilePath, { highWaterMark: 1024 * 1024 }); 

        // Subir a Archive.org
        const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
            method: 'PUT',
            headers: {
                'Authorization': `LOW ${sessions[chatId].accessKey}:${sessions[chatId].secretKey}`,
                'Content-Type': 'video/mp4',
                'Content-Length': fileSize.toString(),
                'x-archive-queue-derive': '0',
                'x-archive-auto-make-bucket': '1',
                'x-archive-meta-mediatype': 'movies',
                'x-archive-size-hint': fileSize.toString()
            },
            body: readStream.pipe(uploadProgressStream),
            duplex: 'half'
        });

        if (!uploadResponse.ok) {
            throw new Error(`Error en la subida: ${await uploadResponse.text()}`);
        }

        // Esperar procesamiento
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Obtener URL del stream
        const directUrl = await getCorrectStreamUrl(identifier, fileName);

        if (directUrl) {
        await bot.sendMessage(chatId,
            '✅ ¡Archivo agregado exitosamente!\n\n' +
            `📋 Página: https://archive.org/details/${identifier}\n` +
            `🎬 Stream directo: ${directUrl}\n` +
            `⬇️ Descarga: https://archive.org/download/${identifier}/${fileName}\n\n` +
            '⏳ Nota: La página puede tardar unos minutos en estar completamente disponible.'
        );
    } else {
        await bot.sendMessage(chatId,
            '✅ ¡Archivo agregado exitosamente!\n\n' +
            `📋 Página: https://archive.org/details/${identifier}\n` +
            `⬇️ Descarga: https://archive.org/download/${identifier}/${fileName}\n\n` +
            '⚠️ La URL de stream estará disponible en unos minutos.\n' +
            '📝 Puedes usar /edit más tarde para ver todas las URLs.'
        );
    }

        // Eliminar mensaje de estado
        await bot.deleteMessage(chatId, statusMessage.message_id);

    } catch (error) {
        console.error('Error completo:', error);
        await bot.sendMessage(chatId, '❌ Error al agregar el archivo: ' + error.message);
    } finally {
        // Cerrar streams explicitamente
        if (readStream) {
            readStream.destroy();
        }
        
        // Limpiar archivo temporal
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch (error) {
            console.error('Error al eliminar archivo temporal:', error);
        }
        
        delete lastUpdateTime[chatId];
        userStates[chatId] = States.IDLE;
        delete uploadData[chatId];
    }
}

async function updateItemMetadata(identifier, metadata, accessKey, secretKey) {
    const url = `https://archive.org/metadata/${identifier}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ...metadata,
                '-target': 'metadata'
            })
        });

        if (!response.ok) {
            throw new Error(`Error al actualizar: ${await response.text()}`);
        }

        return true;
    } catch (error) {
        console.error('Error al actualizar metadatos:', error);
        throw error;
    }
}

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    if (data === 'rename_file') {
        userStates[chatId] = States.AWAITING_RENAME;
        await bot.sendMessage(chatId, '📝 Envía el nuevo nombre para el archivo (incluyendo la extensión):');
    } else if (data === 'continue_upload') {
        userStates[chatId] = States.AWAITING_TITLE;
        await bot.sendMessage(chatId, '📝 Envía un título para el video:');
    } else if (data.startsWith('edit_title_')) {
        const identifier = data.replace('edit_title_', '');
        userStates[chatId] = States.EDITING_TITLE;
        uploadData[chatId] = { editingIdentifier: identifier };
        await bot.sendMessage(chatId, '📝 Envía el nuevo título:');
    } else if (data.startsWith('edit_desc_')) {
        const identifier = data.replace('edit_desc_', '');
        userStates[chatId] = States.EDITING_DESCRIPTION;
        uploadData[chatId] = { editingIdentifier: identifier };
        await bot.sendMessage(chatId, '📝 Envía la nueva descripción:');
    } else if (data.startsWith('edit_coll_')) {
        const identifier = data.replace('edit_coll_', '');
        userStates[chatId] = States.EDITING_COLLECTION;
        uploadData[chatId] = { editingIdentifier: identifier };
        await bot.sendMessage(chatId, '📚 Envía el nuevo nombre de la colección:');
    } else if (data.startsWith('add_file_')) {
        const identifier = data.replace('add_file_', '');
        userStates[chatId] = States.AWAITING_NEW_FILE_URL;
        uploadData[chatId] = { editingIdentifier: identifier };
        await bot.sendMessage(chatId, 
            '🔗 Envía la URL directa del nuevo archivo de video\n' +
            'Ejemplo: https://ejemplo.com/video.mp4\n' +
            'El archivo debe ser menor a 2GB'
        );
    } else if (data === 'back_to_list') {
        await bot.deleteMessage(chatId, messageId);
        const msg = { chat: { id: chatId } };
        bot.emit('text', msg, { text: '/edit' });
    } else if (data.startsWith('edit_')) {
        const identifier = data.replace('edit_', '');
        await handleEditItem(chatId, identifier);
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state = userStates[chatId] || States.IDLE;

    if (msg.text && msg.text.startsWith('/')) return;

    if (msg.video) {
        if (!sessions[chatId]) {
            return bot.sendMessage(chatId, '❌ Primero debes iniciar sesión con /login');
        }
        if (userStates[chatId] === States.UPLOADING) {
            return bot.sendMessage(chatId, '⏳ Ya hay una subida en proceso. Por favor espera.');
        }
        await handleVideoUpload(msg);
        return;
    }

    switch(state) {
        case States.AWAITING_ACCESS_KEY:
            handleAccessKey(msg);
            break;
        case States.AWAITING_SECRET_KEY:
            handleSecretKey(msg);
            break;
        case States.AWAITING_FILE:
            if (msg.text && urlRegex.test(msg.text)) {
                handleFileUrl(msg);
            } else {
                bot.sendMessage(chatId, '❌ Por favor, envía una URL válida');
            }
            break;
        case States.AWAITING_TITLE:
            handleTitle(msg);
            break;
        case States.AWAITING_DESCRIPTION:
            handleDescription(msg);
            break;
        case States.AWAITING_COLLECTION:
            handleCollection(msg);
            break;
        case States.AWAITING_RENAME:
            handleRename(msg);
            break;
        case States.EDITING_TITLE:
            try {
                await updateItemMetadata(uploadData[chatId].editingIdentifier, {
                    title: msg.text
                }, sessions[chatId].accessKey, sessions[chatId].secretKey);
                await bot.sendMessage(chatId, '✅ Título actualizado correctamente');
                userStates[chatId] = States.IDLE;
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Error al actualizar el título');
            }
            break;
        case States.EDITING_DESCRIPTION:
            try {
                await updateItemMetadata(uploadData[chatId].editingIdentifier, {
                    description: msg.text
                }, sessions[chatId].accessKey, sessions[chatId].secretKey);
                await bot.sendMessage(chatId, '✅ Descripción actualizada correctamente');
                userStates[chatId] = States.IDLE;
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Error al actualizar la descripción');
            }
            break;
        case States.EDITING_COLLECTION:
            try {
                await updateItemMetadata(uploadData[chatId].editingIdentifier, {
                    collection: msg.text
                }, sessions[chatId].accessKey, sessions[chatId].secretKey);
                await bot.sendMessage(chatId, '✅ Colección actualizada correctamente');
                userStates[chatId] = States.IDLE;
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Error al actualizar la colección');
            }
            break;
        case States.AWAITING_NEW_FILE_URL:
            if (msg.text && urlRegex.test(msg.text)) {
                uploadData[chatId].newFileUrl = msg.text;
                userStates[chatId] = States.AWAITING_NEW_FILE_NAME;
                await bot.sendMessage(chatId, '📝 Envía el nombre para el nuevo archivo (incluyendo la extensión):');
            } else {
                await bot.sendMessage(chatId, '❌ Por favor, envía una URL válida');
            }
            break;
        case States.AWAITING_NEW_FILE_NAME:
            const fileName = msg.text.trim();
            if (!fileName.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i)) {
                return bot.sendMessage(chatId, '❌ El nombre debe incluir una extensión válida (.mp4, .mkv, etc.)');
            }
            try {
                await addFileToExisting(
                    chatId,
                    uploadData[chatId].editingIdentifier,
                    uploadData[chatId].newFileUrl,
                    fileName
                );
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Error al agregar el archivo: ' + error.message);
            }
            break;
    }
});

async function handleTitle(msg) {
    const chatId = msg.chat.id;
    const title = msg.text.trim();
    
    if (title.length < 1) {
        bot.sendMessage(chatId, '❌ El título no puede estar vacío. Por favor, envía un título válido.');
        return;
    }
    
    uploadData[chatId].title = title;
    userStates[chatId] = States.AWAITING_DESCRIPTION;
    bot.sendMessage(chatId, 
        '📝 Envía una descripción para el video\n' +
        '(Opcional - envía "skip" para omitir)'
    );
}

async function handleDescription(msg) {
    const chatId = msg.chat.id;
    if (msg.text.toLowerCase() !== 'skip') {
        uploadData[chatId].description = msg.text;
    }
    userStates[chatId] = States.AWAITING_COLLECTION;
    bot.sendMessage(chatId,
        '📚 Elige una colección para tu archivo:\n\n' +
        '🎬 Mejores colecciones para películas:\n' +
        '• opensource_movies - ⭐ Mejor opción para películas\n' +
        '• community - ✅ Opción muy estable\n' +
        '• public_media - 👍 Buena para contenido público\n\n' +
        '📚 Otras colecciones disponibles:\n' +
        '• opensource_media - Para medios en general\n' +
        '• open_source_movies - Alternativa para videos\n' +
        '• opensource - Contenido general\n' +
        '• free_media - Contenido libre\n' +
        '• video_archive - Archivos de video\n' +
        '• media_archive - Archivos multimedia\n\n' +
        '📝 Envía el nombre exacto de una de estas colecciones\n' +
        '💡 Recomendado: "opensource_movies" para mejor preservación'
    );
}

async function handleCollection(msg) {
    const chatId = msg.chat.id;
    const collection = msg.text.toLowerCase();
    
    // Colecciones recomendadas para películas
    const recommendedCollections = [
        'opensource_movies',
        'community',
        'public_media'
    ];

    // Todas las colecciones permitidas
    const allowedCollections = [
        ...recommendedCollections,
        'opensource_media',
        'open_source_movies',
        'opensource',
        'free_media',
        'video_archive',
        'media_archive'
    ];

    if (!allowedCollections.includes(collection)) {
        // Si la colección no es válida, sugerir las recomendadas
        await bot.sendMessage(chatId,
            '❌ Colección no válida.\n\n' +
            '🎬 Colecciones recomendadas para películas:\n' +
            '• opensource_movies - ⭐ Mejor opción\n' +
            '• community - ✅ Muy estable\n' +
            '• public_media - 👍 Buena opción\n\n' +
            '📝 Por favor, elige una de estas colecciones para mejor preservación.'
        );
        return;
    }

    if (!recommendedCollections.includes(collection)) {
        // Advertencia si no se elige una de las colecciones recomendadas
        await bot.sendMessage(chatId,
            '⚠️ Nota: Has elegido una colección no recomendada.\n' +
            'Continuando con la subida, pero considera usar:\n' +
            '• opensource_movies\n' +
            '• community\n' +
            '• public_media\n' +
            'Para mejor preservación de tu contenido.'
        );
    }

    uploadData[chatId].collection = collection;
    userStates[chatId] = States.UPLOADING;
    const statusMessage = await bot.sendMessage(chatId, '🚀 Iniciando subida...');
    
    try {
        await uploadToArchive(chatId, statusMessage.message_id);
    } catch (error) {
        console.error('Error en la subida:', error);
        if (error.message.includes('AccessDenied')) {
            uploadData[chatId].collection = 'opensource_movies'; // Cambiar a opensource_movies primero
            await bot.sendMessage(chatId, 
                '⚠️ No se pudo subir a la colección seleccionada.\n' +
                'Intentando con la colección "opensource_movies"...'
            );
            try {
                await uploadToArchive(chatId, statusMessage.message_id);
            } catch (retryError) {
                // Si falla opensource_movies, intentar con community
                uploadData[chatId].collection = 'community';
                await bot.sendMessage(chatId, 
                    '⚠️ Intentando con la colección "community"...'
                );
                try {
                    await uploadToArchive(chatId, statusMessage.message_id);
                } catch (finalError) {
                    await bot.sendMessage(chatId, 
                        '❌ Error en la subida. Por favor, intenta más tarde.'
                    );
                }
            }
        } else {
            await bot.sendMessage(chatId, '❌ Error en la subida: ' + error.message);
        }
    } finally {
        userStates[chatId] = States.IDLE;
    }
}

async function handleRename(msg) {
    const chatId = msg.chat.id;
    const newFileName = msg.text.trim();

    if (!newFileName.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i)) {
        return bot.sendMessage(chatId, '❌ El nombre debe incluir una extensión válida (.mp4, .mkv, etc.)');
    }

    uploadData[chatId].fileName = newFileName;
    userStates[chatId] = States.AWAITING_TITLE;
    await bot.sendMessage(chatId, `✅ Archivo renombrado a: ${newFileName}\n\n📝 Ahora envía un título para la pagina:`);
}

// Manejo de errores global
process.on('unhandledRejection', (error) => {
    console.error('Error no manejado:', error);
});

console.log('Bot iniciado correctamente');
