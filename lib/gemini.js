'use strict';

const axios = require('axios');

const API_KEY = process.env.GEMINI_API_KEY;

// Cadena de prioridad
const MODELOS = [
  process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-2.5-flash',
];

// Registro en memoria de modelos en cooldown por saturación/cuota (5 minutos)
const cooldownModelos = new Map();

function estaEnCooldown(modelo) {
  const expira = cooldownModelos.get(modelo);
  if (!expira) return false;
  if (Date.now() > expira) {
    cooldownModelos.delete(modelo);
    return false;
  }
  return true;
}

function marcarCooldown(modelo, segundos = 300) {
  cooldownModelos.set(modelo, Date.now() + segundos * 1000);
}

function ocultarApiKey(texto) {
  const s = String(texto || '');
  return API_KEY ? s.split(API_KEY).join('<api-key>') : s;
}

/**
 * Llama a la API de Gemini con timeout ajustado y manejo de fallos rápido.
 */
async function llamarApiGemini(modelo, payload, timeoutMs = 45000) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${API_KEY}`;
  return axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
  });
}

/**
 * Ejecuta una petición con failover veloz entre modelos.
 */
async function invocarConFailover(payload, esBusquedaWeb = false) {
  let ultimoError;

  for (const modelo of MODELOS) {
    if (estaEnCooldown(modelo)) {
      continue;
    }

    // Para modelos experimentales damos max 7s; si no responden o están saturados,
    // saltamos de inmediato al caballo de batalla (gemini-2.5-flash).
    const timeoutModelo = modelo === 'gemini-2.5-flash' ? 45000 : 7000;

    try {
      const resp = await llamarApiGemini(modelo, payload, timeoutModelo);
      return { data: resp.data, modeloUsado: modelo };
    } catch (error) {
      ultimoError = error;
      const msg = error.response?.data?.error?.message || error.message || '';
      const codigo = error.response?.status;
      const esSaturacion =
        msg.includes('high demand') ||
        msg.includes('quota') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        error.code === 'ECONNABORTED' ||
        codigo === 503 ||
        codigo === 429;

      if (esSaturacion) {
        console.warn(`[AVISO] ${modelo} saturado o lento (${msg.slice(0, 45)}...). Marcando cooldown y probando siguiente...`);
        marcarCooldown(modelo, 180); // 3 minutos de cooldown
        continue;
      }

      // Si es un error de formato de parámetros, reportar directo
      throw new Error(`Error en ${modelo}: ${ocultarApiKey(msg)}`);
    }
  }

  // Si todos fallaron, último intento forzado a gemini-2.5-flash
  try {
    const resp = await llamarApiGemini('gemini-2.5-flash', payload, 45000);
    return { data: resp.data, modeloUsado: 'gemini-2.5-flash' };
  } catch (err) {
    const detalle = ocultarApiKey(err.response?.data?.error?.message || err.message || '');
    throw new Error(`No se pudo conectar con la IA: ${detalle}`);
  }
}

/**
 * Fase 2: Extrae los datos numéricos y equipos para armar la gráfica.
 */
async function extraerDatosGrafica(textoAnalisis, temaOriginal) {
  const payload = {
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
    systemInstruction: {
      parts: [
        {
          text: `Eres un analista de datos. A partir del texto proporcionado, extrae los elementos y valores numéricos para generar una gráfica estadística.
Devuelve OBLIGATORIAMENTE un JSON con esta estructura exacta:
{
  "titulo": "Título descriptivo del gráfico",
  "tipo": "barras",
  "etiquetas": ["Elemento 1", "Elemento 2", "Elemento 3", "Elemento 4", "Elemento 5"],
  "valores": [30, 25, 20, 15, 10],
  "eje_x": "Nombre del eje X",
  "eje_y": "Probabilidad (%) o Puntos"
}`,
        },
      ],
    },
    contents: [
      {
        parts: [
          {
            text: `Tema: ${temaOriginal}\n\nTexto con el análisis:\n${textoAnalisis}`,
          },
        ],
      },
    ],
  };

  try {
    const { data } = await invocarConFailover(payload, false);
    const textoJson = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (textoJson) {
      const parsed = JSON.parse(textoJson);
      if (parsed.etiquetas && parsed.valores && parsed.etiquetas.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('[GRAFICA EXTRACT ERROR]', e.message);
  }
  return null;
}

/**
 * Procesa la petición inteligente:
 * Si detecta intención de gráfica o predicción visual, ejecuta el pipeline en 2 fases velozmente.
 */
async function procesarPeticionInteligente(prompt, forzarGrafica = false) {
  if (!API_KEY) {
    throw new Error('Falta GEMINI_API_KEY en el archivo .env');
  }

  const promptLower = prompt.toLowerCase();
  const pideGrafica =
    forzarGrafica ||
    promptLower.includes('grafic') ||
    promptLower.includes('chart') ||
    promptLower.includes('visual') ||
    promptLower.includes('imagen') ||
    promptLower.includes('muestrame') ||
    promptLower.includes('muéstrame') ||
    (promptLower.includes('predicci') && (promptLower.includes('probabilid') || promptLower.includes('quien') || promptLower.includes('quién')));

  const pideDoc =
    promptLower.includes('pdf') ||
    promptLower.includes('docx') ||
    promptLower.includes('word') ||
    promptLower.includes('pptx') ||
    promptLower.includes('powerpoint') ||
    promptLower.includes('excel') ||
    promptLower.includes('xlsx');

  const pideCodigo =
    promptLower.includes('script') ||
    promptLower.includes('codigo') ||
    promptLower.includes('código') ||
    promptLower.includes('hazme un programa') ||
    promptLower.includes('una clase en') ||
    promptLower.includes('en python') ||
    promptLower.includes('en java') ||
    promptLower.includes('en c++') ||
    promptLower.includes('un archivo txt');

  // Si pide código o documento estructurado sin requerir búsqueda web
  if ((pideCodigo || pideDoc) && !pideGrafica && !promptLower.includes('liga mx') && !promptLower.includes('noticia') && !promptLower.includes('partido')) {
    const payloadEstructurado = {
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.5,
        maxOutputTokens: 2048,
      },
      systemInstruction: {
        parts: [
          {
            text: `Eres un asistente que entrega archivos o documentos.
Devuelve SIEMPRE JSON:
Para código o texto plano:
{ "tipo": "archivo_texto", "nombre_archivo": "...", "contenido": "...", "mensaje": "..." }
Para documentos ricos:
{ "tipo": "documento_rico", "formato": "pdf|docx|pptx|xlsx", "nombre_archivo": "...", "mensaje": "...", "datos": { "titulo": "...", "secciones": [ { "titulo": "...", "contenido": "..." } ] } }`,
          },
        ],
      },
      contents: [{ parts: [{ text: prompt }] }],
    };

    try {
      const { data, modeloUsado } = await invocarConFailover(payloadEstructurado, false);
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (raw) {
        const parsed = JSON.parse(raw);
        parsed.modelo = modeloUsado;
        return parsed;
      }
    } catch {}
  }

  // Búsqueda en Google Search Grounding en tiempo real (con límite de tokens para velocidad)
  const payloadConSearch = {
    tools: [{ googleSearch: {} }],
    generationConfig: {
      maxOutputTokens: 900, // Conciso y rápido
    },
    contents: [
      {
        parts: [
          {
            text: `Investiga datos actuales en Google y responde de forma concisa:\n${prompt}\nSi hay probabilidades o puntos, incluye los números exactos de los equipos principales.`,
          },
        ],
      },
    ],
  };

  const { data, modeloUsado } = await invocarConFailover(payloadConSearch, true);
  const textoAnalisis = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Si el usuario pidió gráfica o predicción con gráfico, extraemos los datos numéricos y GARANTIZAMOS la gráfica
  if (pideGrafica) {
    const datosGrafica = await extraerDatosGrafica(textoAnalisis, prompt);
    if (datosGrafica) {
      return {
        tipo: 'grafica',
        mensaje: textoAnalisis.trim(),
        datos_grafica: datosGrafica,
        modelo: modeloUsado,
      };
    }
  }

  return {
    tipo: 'texto',
    mensaje: textoAnalisis.trim(),
    modelo: modeloUsado,
  };
}

module.exports = {
  procesarPeticionInteligente,
  MODELO: MODELOS[0],
  MODELOS_PRIORIDAD: MODELOS,
  ocultarApiKey,
};
