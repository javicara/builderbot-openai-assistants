import "dotenv/config";
import {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  EVENTS,
  MemoryDB,
} from "@builderbot/bot";
import { BaileysProvider } from "@builderbot/provider-baileys";
import { PostgreSQLDB } from "./utils/postgresql-db";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008;
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? "";
const userQueues = new Map();
const userLocks = new Map(); // New lock mechanism
const userProfiles = new Map(); // Para almacenar perfiles de usuario

/**
 * Function to process the user's message by sending it to the OpenAI API
 * and sending the response back to the user.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
  await typing(ctx, provider);
  const response = await toAsk(ASSISTANT_ID, ctx.body, state);

  // Split the response into chunks and send them sequentially
  const chunks = response.split(/\n\n+/);
  for (const chunk of chunks) {
    const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
    await flowDynamic([{ body: cleanedChunk }]);
  }
};

/**
 * Function to handle the queue for each user.
 */
const handleQueue = async (userId) => {
  const queue = userQueues.get(userId);

  if (userLocks.get(userId)) {
    return; // If locked, skip processing
  }

  while (queue.length > 0) {
    userLocks.set(userId, true); // Lock the queue
    const { ctx, flowDynamic, state, provider } = queue.shift();
    try {
      await processUserMessage(ctx, { flowDynamic, state, provider });
    } catch (error) {
      console.error(`Error processing message for user ${userId}:`, error);
    } finally {
      userLocks.set(userId, false); // Release the lock
    }
  }

  userLocks.delete(userId); // Remove the lock once all messages are processed
  userQueues.delete(userId); // Remove the queue once all messages are processed
};

/**
 * Flujo para registrar el nombre del usuario
 */
const registerFlow = addKeyword<BaileysProvider, any>([
  "registro",
  "registrar",
  "registrarme",
]).addAnswer(
  "👋 Hola, vamos a registrar tu perfil. ¿Cuál es tu nombre?",
  { capture: true },
  async (ctx, { flowDynamic, state, database }) => {
    const userId = ctx.from;
    const name = ctx.body;

    // Guardar el nombre en el estado
    await state.update({ name });

    try {
      // Guardar en la base de datos PostgreSQL
      await (database as PostgreSQLDB).saveUserProfile(userId, name);

      // También guardar en memoria para acceso rápido
      userProfiles.set(userId, { name });

      await flowDynamic(
        `Gracias ${name}! Tu perfil ha sido registrado correctamente.`
      );
      await flowDynamic(
        "Ahora puedes hacer preguntas y te responderé con la ayuda del asistente de OpenAI."
      );
    } catch (error) {
      console.error("Error al guardar el perfil del usuario:", error);
      await flowDynamic(
        "Lo siento, ha ocurrido un error al registrar tu perfil. Por favor, intenta nuevamente más tarde."
      );
    }
  }
);

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA
 * @type {import('@builderbot/bot').Flow<BaileysProvider, any>}
 */
const welcomeFlow = addKeyword<BaileysProvider, any>(EVENTS.WELCOME)
  .addAnswer("👋 Hola, soy un asistente virtual. ¿En qué puedo ayudarte?")
  .addAnswer(
    [
      "Si es la primera vez que hablas conmigo, puedes registrarte escribiendo *registro*.",
      "O puedes hacerme cualquier pregunta directamente.",
    ].join("\n")
  )
  .addAction(async (ctx, { flowDynamic, state, provider, database }) => {
    const userId = ctx.from;

    try {
      // Intentar obtener el perfil del usuario desde la base de datos
      const dbProfile = await (database as PostgreSQLDB).getUserProfile(userId);

      // Si existe en la base de datos, actualizar la memoria caché
      if (dbProfile) {
        userProfiles.set(userId, { name: dbProfile.name });
        await flowDynamic(
          `Hola de nuevo, ${dbProfile.name}! ¿En qué puedo ayudarte hoy?`
        );
      } else {
        // Verificar si el usuario ya está registrado en memoria
        const userProfile = userProfiles.get(userId);
        if (userProfile) {
          await flowDynamic(
            `Hola de nuevo, ${userProfile.name}! ¿En qué puedo ayudarte hoy?`
          );
        }
      }
    } catch (error) {
      console.error("Error al obtener el perfil del usuario:", error);
      // Continuar con el flujo normal incluso si hay un error
    }

    if (!userQueues.has(userId)) {
      userQueues.set(userId, []);
    }

    const queue = userQueues.get(userId);
    queue.push({ ctx, flowDynamic, state, provider });

    // If this is the only message in the queue, process it immediately
    if (!userLocks.get(userId) && queue.length === 1) {
      await handleQueue(userId);
    }
  });

/**
 * Flujo para manejar cualquier mensaje que no sea un comando específico
 */
const anyMessageFlow = addKeyword<BaileysProvider, any>(
  EVENTS.ACTION
).addAction(async (ctx, { flowDynamic, state, provider }) => {
  const userId = ctx.from;

  if (!userQueues.has(userId)) {
    userQueues.set(userId, []);
  }

  const queue = userQueues.get(userId);
  queue.push({ ctx, flowDynamic, state, provider });

  // If this is the only message in the queue, process it immediately
  if (!userLocks.get(userId) && queue.length === 1) {
    await handleQueue(userId);
  }
});

/**
 * Función principal que configura y inicia el bot
 * @async
 * @returns {Promise<void>}
 */
const main = async () => {
  /**
   * Flujo del bot
   * @type {import('@builderbot/bot').Flow<BaileysProvider, any>}
   */
  const adapterFlow = createFlow([welcomeFlow, registerFlow, anyMessageFlow]);

  /**
   * Proveedor de servicios de mensajería
   * @type {BaileysProvider}
   */
  const adapterProvider = createProvider(BaileysProvider, {
    groupsIgnore: true,
    readStatus: false,
  });

  /**
   * Base de datos PostgreSQL para el bot
   * @type {PostgreSQLDB}
   */
  const adapterDB = new PostgreSQLDB({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "builderbot",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    schema: process.env.DB_SCHEMA || "public",
  });

  /**
   * Configuración y creación del bot
   * @type {import('@builderbot/bot').Bot<BaileysProvider, any>}
   */
  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB as any,
  });

  httpInject(adapterProvider.server);
  httpServer(+PORT);
};

main();
