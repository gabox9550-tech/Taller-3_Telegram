'use strict';
 
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');

const proc = require('./lib/procesos');
const { descargar } = require('./lib/archivos');

// --- 1. Configuracion -------------------------------------------------------

// Lee .env sin dependencias externas: una linea KEY=VALOR por variable.
function cargarEnv() {
  const ruta = path.join(__dirname, '.env');
  if (!fs.existsSync(ruta)) return;
  for (const linea of fs.readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
cargarEnv();

const gemini = require('./lib/gemini');

const TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(TOKEN || 'sin-token');

if (!TOKEN) {
  console.error('[AVISO] Falta BOT_TOKEN: copia .env.example a .env y pega el token.');
}

// Los errores de red de Telegraf incluyen la URL completa, token incluido.
// Todo lo que se imprime en consola pasa por aqui.
function sinToken(texto) {
  let s = String(texto);
  if (TOKEN) s = s.split(TOKEN).join('<token>');
  if (process.env.GEMINI_API_KEY) s = s.split(process.env.GEMINI_API_KEY).join('<api-key>');
  return s;
}

bot.use((ctx, next) => {
  // No registrar ctx completo ni el texto: pueden incluir datos privados y el token.
  const mensaje = ctx.message;
  const tipo = mensaje?.text ? 'texto'
    : mensaje?.photo ? 'foto'
    : mensaje?.document ? 'documento'
    : ctx.updateType;
  console.log(`[update] ${ctx.updateType}: ${tipo}`);
  return next();
});

// /id va ANTES del filtro de acceso: asi cualquiera puede averiguar su id.
bot.command('id', (ctx) => ctx.reply('Tu id de Telegram es: ' + ctx.from.id));

// Quien puede usar el bot. Con USUARIOS_PERMITIDOS vacio el bot es abierto
// (comodo en el taller); en cuanto lo llenas, solo esos ids pasan.
// Este filtro tambien protege los botones: un callback query es un update mas.
const PERMITIDOS = (process.env.USUARIOS_PERMITIDOS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

bot.use((ctx, next) => {
  if (PERMITIDOS.length === 0) return next();
  if (PERMITIDOS.includes(String(ctx.from?.id))) return next();
  console.log('[bloqueado] usuario no permitido');
});


// --- 2. Utilidades del bot --------------------------------------------------

const AYUDA =
  'Comandos del taller:\n\n' +
  '/ia <petición>        IA inteligente: texto, código (.py, .java), docs (.pdf, .docx) o gráficas\n' +
  '/grafica <tema>       crea SIEMPRE una gráfica en PNG con datos reales (matplotlib)\n' +
  '/sumar 2 3            suma usando Python\n' +
  '/multiplicar 4 2.5    multiplica usando Python\n' +
  '/fibonacci <n>        calcula el n-ésimo número de Fibonacci en Python\n' +
  '/exe sumar 7 5        invoca calculadora.exe directamente\n' +
  '/calcular 7 5         te muestra botones para elegir\n' +
  '/id                   muestra tu id de Telegram\n' +
  '/pdf                  elige y descarga una presentación en PDF\n' +
  '/imagen o /gif        envia el GIF animado\n\n' +
  'Tambien puedes enviarme un documento o una foto.';

/** Responde sin romper el bot si algo falla. */
async function responder(ctx, texto) {
  try {
    await ctx.reply(texto, { disable_web_page_preview: true });
  } catch (e) {
    console.error('No se pudo responder:', sinToken(e.message));
  }
}

/** Extrae dos numeros del texto; devuelve null si no son validos. */
function leerDosNumeros(texto) {
  const partes = String(texto || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length !== 2) return null;
  const nums = partes.map(Number);
  return nums.every(Number.isFinite) ? nums : null;
}

/** Formatea un error de proceso para el usuario. */
function textoError(e) {
  if (e.code === 'ENOENT' || e.code === 'EACCES') {
    return 'No se encontró el programa. Revisa que "python" esté en el PATH ' +
           'y que bin/calculadora.exe exista (solo funciona en Windows; ' +
           'si falta, ejecuta compilar-exe.bat).';
  }
  if (e.killed || e.signal) {
    return 'El proceso tardó demasiado y se canceló.';
  }
  return 'Error al ejecutar: ' + (e.detalle || e.message);
}

/**
 * Envia un documento a Telegram con reintentos usando axios.
 * Esto evita el error "socket hang up" nativo de Telegraf en Node moderno.
 */
async function enviarDocumentoResistente(ctx, buffer, nombreArchivo, caption = '') {
  const url = `https://api.telegram.org/bot${TOKEN}/sendDocument`;

  for (let intento = 1; intento <= 3; intento++) {
    try {
      const form = new FormData();
      form.append('chat_id', String(ctx.chat.id));
      if (caption) {
        form.append('caption', caption);
      }
      
      form.append('document', buffer, {
        filename: nombreArchivo,
        contentType: nombreArchivo.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      });

      await axios.post(url, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 180000, 
      });

      return true; 
    } catch (err) {
      const detalle = sinToken(err.response ? JSON.stringify(err.response.data) : err.message);
      console.error(`[AVISO] Error al enviar el archivo (intento ${intento}/3): ${detalle}`);
      if (intento < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await responder(ctx, '⚠️ No se pudo enviar el archivo después de varios intentos.');
  return false;
}

/**
 * Envia una imagen o GIF animado a Telegram usando axios para evitar cortes de red.
 */
async function enviarMediaResistente(ctx, buffer, nombreArchivo, caption = '') {
  const esAnimacion = nombreArchivo.toLowerCase().endsWith('.gif') || nombreArchivo.toLowerCase().endsWith('.mp4');
  const metodo = esAnimacion ? 'sendAnimation' : 'sendPhoto';
  const campo = esAnimacion ? 'animation' : 'photo';
  const contentType = esAnimacion ? 'image/gif' : 'image/jpeg';
  const url = `https://api.telegram.org/bot${TOKEN}/${metodo}`;

  for (let intento = 1; intento <= 3; intento++) {
    try {
      const form = new FormData();
      form.append('chat_id', String(ctx.chat.id));
      if (caption) {
        form.append('caption', caption);
      }
      
      form.append(campo, buffer, {
        filename: nombreArchivo,
        contentType: contentType, 
      });

      await axios.post(url, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 180000, 
      });

      return true; 
    } catch (err) {
      const detalle = sinToken(err.response ? JSON.stringify(err.response.data) : err.message);
      console.error(`[AVISO] Error al enviar el medio (intento ${intento}/3): ${detalle}`);
      if (intento < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await responder(ctx, '⚠️ No se pudo enviar el archivo después de varios intentos.');
  return false;
}

// --- 3. Comandos basicos ----------------------------------------------------

bot.start((ctx) => responder(ctx, 'Hola 👋 Soy el bot.\n\n' + AYUDA));
bot.help((ctx) => responder(ctx, AYUDA));

// Función principal para procesar con IA y despachar el formato correspondiente
async function ejecutarIA(ctx, prompt, forzarGrafica = false) {
  try {
    await ctx.sendChatAction('typing');
  } catch {}

  let mensajeEspera;
  try {
    const textoAviso = forzarGrafica
      ? '📊 Investigando datos en vivo y generando gráfica...'
      : '🧠 Procesando con inteligencia artificial...';
    mensajeEspera = await ctx.reply(textoAviso);
  } catch {}

  try {
    const resultado = await gemini.procesarPeticionInteligente(prompt, forzarGrafica);

    // Borramos el mensaje de espera
    if (mensajeEspera?.message_id) {
      try {
        await ctx.deleteMessage(mensajeEspera.message_id);
      } catch {}
    }

    // 1) Si se generó una gráfica estadística visual (PNG con matplotlib)
    if (resultado.tipo === 'grafica' && resultado.datos_grafica) {
      const rutaTempJson = path.join(os.tmpdir(), `grafica_${Date.now()}.json`);
      const rutaTempPng = path.join(os.tmpdir(), `grafica_${Date.now()}.png`);

      fs.writeFileSync(rutaTempJson, JSON.stringify(resultado.datos_grafica), 'utf8');

      try {
        await proc.generarGrafica(rutaTempPng, rutaTempJson);
        const buffer = fs.readFileSync(rutaTempPng);
        const tituloGrafica = resultado.datos_grafica.titulo || 'Gráfica estadística generada con datos en tiempo real';

        // 1. Enviamos la imagen con un caption conciso y limpio
        await enviarMediaResistente(ctx, buffer, 'grafica.png', `📊 ${tituloGrafica}`);

        // 2. Enviamos el análisis completo en mensaje(s) de texto independiente para evitar recortes en Telegram
        const textoAnalisis = (resultado.mensaje || '').trim();
        if (textoAnalisis) {
          for (let i = 0; i < textoAnalisis.length; i += 4000) {
            await ctx.reply(textoAnalisis.slice(i, i + 4000));
          }
        }
      } finally {
        try { if (fs.existsSync(rutaTempJson)) fs.unlinkSync(rutaTempJson); } catch {}
        try { if (fs.existsSync(rutaTempPng)) fs.unlinkSync(rutaTempPng); } catch {}
      }
      return;
    }

    // 2) Si la IA decidió entregar código o archivo de texto plano
    if (resultado.tipo === 'archivo_texto') {
      const nombreArchivo = resultado.nombre_archivo || 'archivo.txt';
      const buffer = Buffer.from(resultado.contenido || '', 'utf8');
      const caption = resultado.mensaje
        ? `📄 ${resultado.mensaje}`
        : `📄 Archivo generado: ${nombreArchivo}`;
      await enviarDocumentoResistente(ctx, buffer, nombreArchivo, caption);
      return;
    }

    // 3) Si la IA decidió entregar un documento rico (PDF, DOCX, PPTX, XLSX)
    if (resultado.tipo === 'documento_rico') {
      const formato = (resultado.formato || 'pdf').toLowerCase();
      const nombreArchivo = resultado.nombre_archivo || `documento.${formato}`;
      const rutaTempJson = path.join(os.tmpdir(), `gemini_${Date.now()}.json`);
      const rutaTempSalida = path.join(os.tmpdir(), nombreArchivo);

      fs.writeFileSync(
        rutaTempJson,
        JSON.stringify(resultado.datos || { titulo: 'Documento', secciones: [] }),
        'utf8'
      );

      try {
        await proc.generarDocumentoRico(formato, rutaTempSalida, rutaTempJson);
        const buffer = fs.readFileSync(rutaTempSalida);
        const caption = resultado.mensaje
          ? `📑 ${resultado.mensaje}`
          : `📑 ${nombreArchivo}`;
        await enviarDocumentoResistente(ctx, buffer, nombreArchivo, caption);
      } finally {
        try { if (fs.existsSync(rutaTempJson)) fs.unlinkSync(rutaTempJson); } catch {}
        try { if (fs.existsSync(rutaTempSalida)) fs.unlinkSync(rutaTempSalida); } catch {}
      }
      return;
    }

    // 4) Respuesta conversacional o teórica normal en texto
    const textoRespuesta = resultado.mensaje || 'No se pudo generar la respuesta.';
    if (textoRespuesta.length <= 4000) {
      await ctx.reply(textoRespuesta);
    } else {
      for (let i = 0; i < textoRespuesta.length; i += 4000) {
        await ctx.reply(textoRespuesta.slice(i, i + 4000));
      }
    }
  } catch (error) {
    const errorLimpio = sinToken(error.message);
    console.error('[IA ERROR]', errorLimpio);
    if (mensajeEspera?.message_id) {
      try {
        await ctx.editMessageText(mensajeEspera.message_id, undefined, '❌ ' + errorLimpio);
        return;
      } catch {}
    }
    await responder(ctx, '❌ ' + errorLimpio);
  }
}

// /ia o /gemini procesa de forma autónoma e inteligente la petición
bot.command(['ia', 'gemini'], async (ctx) => {
  const prompt = String(ctx.payload || '').trim();

  if (!prompt) {
    return responder(
      ctx,
      '🤖 *Asistente Inteligente*\n\n' +
      'Pídeme lo que necesites en lenguaje natural:\n' +
      '• *Explicaciones*: `/ia ¿Qué es la memoria virtual?`\n' +
      '• *Gráficas en tiempo real*: `/grafica predicción Liga MX` o `/ia haz una gráfica de X`\n' +
      '• *Código/Scripts*: `/ia Hazme un script en python para descomprimir un zip`\n' +
      '• *Documentos*: `/ia Genera un reporte en PDF sobre arquitectura limpia`\n\n' +
      'Detecto automáticamente si entregarte texto, código, documento o gráfica.'
    );
  }

  return ejecutarIA(ctx, prompt, false);
});

// /grafica o /chart fuerza SIEMPRE la generación visual de una gráfica
bot.command(['grafica', 'chart', 'grafico'], async (ctx) => {
  const prompt = String(ctx.payload || '').trim();

  if (!prompt) {
    return responder(
      ctx,
      '📊 *Generador de Gráficas en Tiempo Real*\n\n' +
      'Uso: `/grafica <tema o consulta>`\n' +
      'Ejemplo: `/grafica Predicción y probabilidades de la Liga MX`\n' +
      'Ejemplo: `/grafica Comparativa de puntos de la Premier League`\n' +
      'Ejemplo: `/grafica Lenguajes de programación más usados`'
    );
  }

  return ejecutarIA(ctx, prompt, true);
});

// /sumar y /multiplicar usan el script de Python.
for (const operacion of ['sumar', 'multiplicar']) {
  bot.command(operacion, async (ctx) => {
    const nums = leerDosNumeros(ctx.payload);
    if (!nums) {
      return responder(ctx, 'Uso: /' + operacion + ' <numero> <numero>\nEjemplo: /' + operacion + ' 2 3');
    }
    try {
      const { stdout } = await proc.ejecutarPython(operacion, nums[0], nums[1]);
      await responder(ctx, '🐍 ' + stdout);
    } catch (e) {
      await responder(ctx, textoError(e));
    }
  });
}

// /fibonacci invoca el script de Python para calcular el n-ésimo número.
bot.command(['fibonacci', 'fibo'], async (ctx) => {
  const arg = String(ctx.payload || '').trim();

  if (!arg) {
    return responder(ctx, 'Uso: /fibonacci <n>\nEjemplo: /fibonacci 10\nCalcula el n-ésimo número de la serie usando Python.');
  }

  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    return responder(ctx, 'Por favor ingresa un número entero positivo válido entre 1 y 500 (ejemplo: /fibonacci 10).');
  }

  try {
    const { stdout } = await proc.ejecutarFibonacci(n);
    await responder(ctx, '🐍 ' + stdout);
  } catch (e) {
    await responder(ctx, textoError(e));
  }
});

// /exe invoca el binario de consola directamente.
bot.command('exe', async (ctx) => {
  const partes = String(ctx.payload || '').trim().split(/\s+/).filter(Boolean);
  const operacion = (partes.shift() || '').toLowerCase();

  if (!proc.OPERACIONES.includes(operacion)) {
    return responder(ctx, 'Uso: /exe <sumar|multiplicar> <numero> <numero>\nEjemplo: /exe sumar 7 5');
  }

  const nums = leerDosNumeros(partes.join(' '));
  if (!nums) {
    return responder(ctx, 'Faltan los dos numeros. Ejemplo: /exe sumar 7 5');
  }

  try {
    const { stdout } = await proc.ejecutarExe(operacion, nums[0], nums[1]);
    await responder(ctx, '⚙️ Binario (' + path.basename(proc.EXE) + ') respondió:\n' + stdout);
  } catch (e) {
    await responder(ctx, textoError(e));
  }
});


// --- Teclados en linea y callback queries ----------------------------------
//
//  Un teclado en linea son botones pegados al mensaje. Cada boton lleva un
//  callback_data (maximo 64 bytes). Al pulsarlo Telegram NO manda texto:
//  manda un "callback query" con ese callback_data, y Telegraf lo entrega
//  a bot.action(...).
//
//      /calcular 7 5  ->  [botones]  ->  clic  ->  bot.action  ->  .exe/Python
//
//  Aqui el callback_data lleva todo lo necesario ("calc:sumar:exe:7:5"),
//  asi que el bot no guarda nada en memoria entre el comando y el clic.

const MOTORES = { py: '🐍 Python', exe: '⚙️ .exe' };

bot.command('calcular', async (ctx) => {
  const nums = leerDosNumeros(ctx.payload);
  if (!nums) {
    return responder(ctx, 'Uso: /calcular <numero> <numero>\nEjemplo: /calcular 7 5');
  }
  const [a, b] = nums;

  // El dato mas largo posible debe caber en 64 bytes.
  if (Buffer.byteLength(`calc:multiplicar:exe:${a}:${b}`) > 64) {
    return responder(ctx, 'Esos numeros son demasiado largos para un boton.');
  }

  const boton = (texto, operacion, motor) =>
    Markup.button.callback(texto, `calc:${operacion}:${motor}:${a}:${b}`);

  const teclado = Markup.inlineKeyboard([
    [boton('➕ Sumar con Python', 'sumar', 'py'),
     boton('➕ Sumar con .exe', 'sumar', 'exe')],
    [boton('✖️ Multiplicar con Python', 'multiplicar', 'py'),
     boton('✖️ Multiplicar con .exe', 'multiplicar', 'exe')],
  ]);

  await ctx.reply(`¿Qué hago con ${a} y ${b}?`, teclado);
});

// Atrapa cualquier boton cuyo callback_data tenga la forma calc:op:motor:a:b
bot.action(/^calc:(sumar|multiplicar):(py|exe):([^:]+):([^:]+)$/, async (ctx) => {
  // ctx.match es el resultado de la expresion regular.
  const [, operacion, motor, a, b] = ctx.match;

  // 1) Siempre contestar el clic: apaga el relojito del boton.
  await ctx.answerCbQuery('Calculando...');

  // 2) Cambiar el mensaje. Al editar sin reply_markup, los botones
  //    desaparecen: asi no se pulsan dos veces.
  await ctx.editMessageText('⏳ Ejecutando con ' + MOTORES[motor] + '...');

  // 3) Ejecutar. El callback_data NO es de fiar: ejecutarExe y
  //    ejecutarPython vuelven a validar operacion y numeros.
  try {
    const ejecutar = motor === 'exe' ? proc.ejecutarExe : proc.ejecutarPython;
    const { stdout } = await ejecutar(operacion, a, b);
    await ctx.editMessageText(MOTORES[motor] + '\n' + stdout);
  } catch (e) {
    await ctx.editMessageText(textoError(e));
  }
});

// --- Enviar archivos locales ---

const LISTA_PDFS = {
  jbutton: {
    archivo: 'jbutton_java.pdf',
    titulo: '🔘 JButton in Java (Jesús Olvera)',
    nombreDescarga: 'JButton_en_Java.pdf',
    caption: '📄 JButton in Java - Tópicos Avanzados de Programación (Jesús Olvera)',
  },
  gridlayout: {
    archivo: 'gridlayout_java.pdf',
    titulo: '🪟 GridLayout (Cruz Méndez)',
    nombreDescarga: 'GridLayout_Java.pdf',
    caption: '📄 12.18.3 GridLayout - Presentado por Cruz Méndez Mauro Eduardo',
  },
};

/** Función auxiliar para enviar un PDF por su clave */
async function despacharPdf(ctx, clave) {
  const docInfo = LISTA_PDFS[clave];
  if (!docInfo) return;

  const rutaPdf = path.join(__dirname, 'datos', 'paraEnviar', docInfo.archivo);
  if (!fs.existsSync(rutaPdf)) {
    return responder(ctx, `⚠️ No se encontró el archivo ${docInfo.archivo} en datos/paraEnviar/`);
  }

  try {
    const archivoBuffer = fs.readFileSync(rutaPdf);
    await enviarDocumentoResistente(ctx, archivoBuffer, docInfo.nombreDescarga, docInfo.caption);
  } catch (e) {
    await responder(ctx, 'Error al enviar el PDF: ' + e.message);
  }
}

bot.command('pdf', async (ctx) => {
  const arg = String(ctx.payload || '').trim().toLowerCase();

  // Si el usuario especificó directamente /pdf 1, /pdf 2, /pdf jbutton o /pdf gridlayout
  if (arg === '1' || arg === 'jbutton') {
    return despacharPdf(ctx, 'jbutton');
  }
  if (arg === '2' || arg === 'gridlayout') {
    return despacharPdf(ctx, 'gridlayout');
  }

  // Si no especificó argumento, mostramos teclado interactivo con botones inline
  const teclado = Markup.inlineKeyboard([
    [Markup.button.callback('🔘 JButton in Java (Jesús Olvera)', 'pdf:jbutton')],
    [Markup.button.callback('🪟 GridLayout (Cruz Méndez)', 'pdf:gridlayout')],
  ]);

  await ctx.reply('📚 ¿Qué presentación deseas descargar?', teclado);
});

// Callback query cuando el usuario pulsa uno de los botones de PDF
bot.action(/^pdf:(jbutton|gridlayout)$/, async (ctx) => {
  const clave = ctx.match[1];
  const docInfo = LISTA_PDFS[clave];
  if (!docInfo) return;

  await ctx.answerCbQuery(`Enviando ${docInfo.nombreDescarga}...`);
  await ctx.editMessageText(`⏳ Preparando y enviando: ${docInfo.titulo}...`);

  await despacharPdf(ctx, clave);
});

bot.command(['imagen', 'gif'], async (ctx) => {
  const rutaGif = path.join(__dirname, 'datos', 'paraEnviar', 'ejemplo.gif');
  const rutaJpg = path.join(__dirname, 'datos', 'paraEnviar', 'ejemplo.jpg');
  const rutaArchivo = fs.existsSync(rutaGif) ? rutaGif : rutaJpg;
  
  if (!fs.existsSync(rutaArchivo)) {
    return responder(ctx, '⚠️ No se encontró la imagen/GIF en datos/paraEnviar/');
  }

  try {
    const archivoBuffer = fs.readFileSync(rutaArchivo);
    const nombre = path.basename(rutaArchivo);

    await enviarMediaResistente(
      ctx,
      archivoBuffer,
      nombre,
      '' // Sin descripción
    );
  } catch (e) {
    await responder(ctx, 'Error al enviar la imagen: ' + e.message);
  }
});

// --- 5. Documentos e imagenes ----------------------------------------------

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  try {
      const info = await descargar(ctx, doc.file_id, doc.file_name, doc.file_size);
    await responder(
      ctx,
      '📄 Documento guardado\n' +
      'Nombre: ' + (doc.file_name || 'sin nombre') + '\n' +
      'Tipo: ' + (doc.mime_type || 'desconocido') + '\n' +
      'Tamaño: ' + info.bytes + ' bytes\n' +
      'Archivo local: ' + path.basename(info.ruta) + '\n' +
      'SHA-256: ' + info.sha256.slice(0, 20) + '...'
    );
  } catch (e) {
    await responder(ctx, 'No pude descargar el documento: ' + e.message);
  }
});

bot.on('photo', async (ctx) => {
  // Telegram manda varias resoluciones; la última es la más grande.
  const foto = ctx.message.photo[ctx.message.photo.length - 1];
  try {
    const nombre = 'foto_' + foto.width + 'x' + foto.height + '.jpg';
    const info = await descargar(ctx, foto.file_id, nombre, foto.file_size);
    await responder(
      ctx,
      '🖼️ Imagen guardada\n' +
      'Resolucion: ' + foto.width + ' x ' + foto.height + '\n' +
      'Tamano: ' + info.bytes + ' bytes\n' +
      'Archivo local: ' + path.basename(info.ruta)
    );
  } catch (e) {
    await responder(ctx, 'No pude descargar la imagen: ' + e.message);
  }
});

// --- 6. Fallback y arranque -------------------------------------------------

// Se registra al final: cualquier texto que no sea comando cae aqui.
bot.on('text', (ctx) => responder(ctx, 'No reconozco ese mensaje.\n\n' + AYUDA));

bot.catch((err, ctx) => {
  console.error('Error en', ctx.updateType, ':', sinToken(err.message));
});

// Permite importar el bot desde pruebas sin arrancar el polling.
module.exports = bot;

// --- Arranque ---------------------------------------------------------------
if (require.main === module) {
  if (!TOKEN) {
    console.error('No se puede arrancar sin BOT_TOKEN.');
    process.exit(1);
  }

  bot.launch().then(() => {
    console.log('Bot del taller listo. Abre Telegram y envia /start.');
    console.log('Python:', proc.PYTHON, '| Exe:', proc.EXE);
  }).catch((e) => {
    console.error('No se pudo iniciar el bot:', sinToken(e.message));
    process.exit(1);
  });

  // Apagado limpio con Ctrl+C.
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
