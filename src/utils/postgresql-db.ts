import pgPromise from "pg-promise";

/**
 * Opciones de configuración para la conexión a PostgreSQL
 */
interface PostgreSQLDBOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema?: string;
}

/**
 * Adaptador de base de datos PostgreSQL para BuilderBot
 * Implementa la misma interfaz que MemoryDB
 */
export class PostgreSQLDB {
  // Implementar métodos requeridos por la interfaz MemoryDB
  private db: any;
  private schema: string;
  private initialized: boolean = false;

  /**
   * Constructor del adaptador PostgreSQL
   * @param options Opciones de conexión a PostgreSQL
   */
  constructor(options: PostgreSQLDBOptions) {
    const pgp = pgPromise();

    this.schema = options.schema || "public";

    this.db = pgp({
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
    });
  }

  /**
   * Inicializa la base de datos creando las tablas necesarias si no existen
   */
  async init() {
    if (this.initialized) return;

    try {
      // Crear esquema si no existe
      await this.db.none(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);

      // Crear tabla para almacenar los mensajes/conversaciones
      await this.db.none(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.messages (
          id SERIAL PRIMARY KEY,
          ref TEXT NOT NULL,
          keyword TEXT,
          answer TEXT,
          options JSONB,
          refSerialize TEXT,
          "from" TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Crear tabla para almacenar el estado de los usuarios
      await this.db.none(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.states (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          data JSONB NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Crear tabla para almacenar perfiles de usuario
      await this.db.none(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.user_profiles (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.initialized = true;
      console.log("PostgreSQL database initialized successfully");
    } catch (error) {
      console.error("Error initializing PostgreSQL database:", error);
      throw error;
    }
  }

  /**
   * Guarda un mensaje en la base de datos
   * @param data Datos del mensaje a guardar
   */
  async save(data: any) {
    await this.init();

    try {
      const { ref, keyword, answer, options, refSerialize, from } = data;

      await this.db.none(
        `
        INSERT INTO ${this.schema}.messages 
        (ref, keyword, answer, options, refSerialize, "from")
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
        [
          ref,
          keyword,
          answer,
          JSON.stringify(options || {}),
          refSerialize,
          from,
        ]
      );

      return data;
    } catch (error) {
      console.error("Error saving message to PostgreSQL:", error);
      throw error;
    }
  }

  /**
   * Busca mensajes en la base de datos
   * @param match Criterios de búsqueda
   */
  async find(match: any = {}) {
    await this.init();

    try {
      let query = `SELECT * FROM ${this.schema}.messages WHERE 1=1`;
      const params: any[] = [];
      let paramIndex = 1;

      // Construir la consulta basada en los criterios de búsqueda
      if (match.ref) {
        query += ` AND ref = $${paramIndex++}`;
        params.push(match.ref);
      }

      if (match.keyword) {
        query += ` AND keyword = $${paramIndex++}`;
        params.push(match.keyword);
      }

      if (match.from) {
        query += ` AND "from" = $${paramIndex++}`;
        params.push(match.from);
      }

      if (match.refSerialize) {
        query += ` AND refSerialize = $${paramIndex++}`;
        params.push(match.refSerialize);
      }

      const results = await this.db.any(query, params);

      // Convertir las opciones de JSONB a objeto JavaScript
      return results.map((row: any) => ({
        ...row,
        options:
          typeof row.options === "string"
            ? JSON.parse(row.options)
            : row.options,
      }));
    } catch (error) {
      console.error("Error finding messages in PostgreSQL:", error);
      throw error;
    }
  }

  /**
   * Actualiza el estado de un usuario
   * @param userId ID del usuario
   * @param data Datos del estado
   */
  async updateState(userId: string, data: any) {
    await this.init();

    try {
      // Usar upsert para insertar o actualizar
      await this.db.none(
        `
        INSERT INTO ${this.schema}.states (user_id, data, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) 
        DO UPDATE SET data = $2, updated_at = CURRENT_TIMESTAMP
      `,
        [userId, JSON.stringify(data)]
      );

      return data;
    } catch (error) {
      console.error("Error updating state in PostgreSQL:", error);
      throw error;
    }
  }

  /**
   * Obtiene el estado de un usuario
   * @param userId ID del usuario
   */
  async getState(userId: string) {
    await this.init();

    try {
      const result = await this.db.oneOrNone(
        `
        SELECT data FROM ${this.schema}.states WHERE user_id = $1
      `,
        [userId]
      );

      if (!result) return {};

      return typeof result.data === "string"
        ? JSON.parse(result.data)
        : result.data;
    } catch (error) {
      console.error("Error getting state from PostgreSQL:", error);
      throw error;
    }
  }

  /**
   * Elimina mensajes de la base de datos
   * @param match Criterios para eliminar
   */
  async delete(match: any = {}) {
    await this.init();

    try {
      let query = `DELETE FROM ${this.schema}.messages WHERE 1=1`;
      const params: any[] = [];
      let paramIndex = 1;

      // Construir la consulta basada en los criterios
      if (match.ref) {
        query += ` AND ref = $${paramIndex++}`;
        params.push(match.ref);
      }

      if (match.keyword) {
        query += ` AND keyword = $${paramIndex++}`;
        params.push(match.keyword);
      }

      if (match.from) {
        query += ` AND "from" = $${paramIndex++}`;
        params.push(match.from);
      }

      if (match.refSerialize) {
        query += ` AND refSerialize = $${paramIndex++}`;
        params.push(match.refSerialize);
      }

      await this.db.none(query, params);
      return true;
    } catch (error) {
      console.error("Error deleting messages from PostgreSQL:", error);
      throw error;
    }
  }

  /**
   * Cierra la conexión a la base de datos
   */
  async close() {
    try {
      if (this.db.$pool) {
        await this.db.$pool.end();
      }
    } catch (error) {
      console.error("Error closing PostgreSQL connection:", error);
    }
  }

  /**
   * Guarda el perfil de un usuario
   * @param userId ID del usuario
   * @param name Nombre del usuario
   * @returns Perfil del usuario
   */
  async saveUserProfile(userId: string, name: string) {
    await this.init();

    try {
      // Usar upsert para insertar o actualizar
      await this.db.none(
        `
        INSERT INTO ${this.schema}.user_profiles (user_id, name, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) 
        DO UPDATE SET name = $2, updated_at = CURRENT_TIMESTAMP
      `,
        [userId, name]
      );

      return { userId, name };
    } catch (error) {
      console.error("Error saving user profile to PostgreSQL:", error);
      throw error;
    }
  }

  /**
   * Obtiene el perfil de un usuario
   * @param userId ID del usuario
   * @returns Perfil del usuario o null si no existe
   */
  async getUserProfile(userId: string) {
    await this.init();

    try {
      const result = await this.db.oneOrNone(
        `
        SELECT user_id, name FROM ${this.schema}.user_profiles WHERE user_id = $1
      `,
        [userId]
      );

      if (!result) return null;

      return {
        userId: result.user_id,
        name: result.name,
      };
    } catch (error) {
      console.error("Error getting user profile from PostgreSQL:", error);
      return null;
    }
  }

  /**
   * Obtiene el historial de mensajes
   * @param match Criterios de búsqueda
   * @returns Lista de mensajes
   */
  async listHistory(match: any = {}) {
    return this.find(match);
  }

  /**
   * Obtiene los mensajes previos por número
   * @param from ID del usuario
   * @param limit Número de mensajes a obtener
   * @returns Lista de mensajes previos
   */
  async getPrevByNumber(from: string, limit: number = 10) {
    await this.init();

    try {
      const results = await this.db.any(
        `
        SELECT * FROM ${this.schema}.messages 
        WHERE "from" = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
        [from, limit]
      );

      // Convertir las opciones de JSONB a objeto JavaScript
      return results.map((row: any) => ({
        ...row,
        options:
          typeof row.options === "string"
            ? JSON.parse(row.options)
            : row.options,
      }));
    } catch (error) {
      console.error("Error getting previous messages from PostgreSQL:", error);
      return [];
    }
  }
}
