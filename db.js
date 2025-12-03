import { createClient } from "@libsql/client";
import 'dotenv/config';
import bcrypt from 'bcryptjs';

// 🔑 Configuración del Cliente Turso/LibSQL
export const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// 🟢 FUNCIÓN DE AYUDA: Generador simple de código alfanumérico
function generateRandomCode(length = 6) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Inicializa la base de datos: crea tablas si no existen y aplica migraciones
 */
export async function initializeDb() {
    try {
        // 1. Tabla USERS
        await client.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                phone TEXT,
                password_hash TEXT NOT NULL,
                referral_code TEXT,
                role TEXT DEFAULT 'Usuario' NOT NULL,
                transactions_history TEXT DEFAULT '[]',
                balance REAL DEFAULT 0.00,
                discount_percentage INTEGER DEFAULT 0,
                is_banned INTEGER DEFAULT 0,
                is_approved INTEGER DEFAULT 1,
                referred_by_user_id INTEGER DEFAULT NULL,
                premium_expires_at DATETIME DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'users' table ready.");

        // 🟢 MIGRACIÓN AUTOMÁTICA: Verificar y agregar 'plain_password' si falta
        try {
            // Intentamos seleccionar la columna. Si falla, es que no existe.
            await client.execute("SELECT plain_password FROM users LIMIT 1");
        } catch (e) {
            console.log("🟡 Migrating: Adding 'plain_password' column to users table...");
            await client.execute("ALTER TABLE users ADD COLUMN plain_password TEXT");
            console.log("✅ Migration successful: 'plain_password' column added.");
        }

        // 2. Tabla PRODUCTS
        await client.execute(`
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                price REAL NOT NULL,
                stock INTEGER DEFAULT 0,
                category_id INTEGER,
                is_available INTEGER DEFAULT 1,
                image_url TEXT,
                created_by_user_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'products' table ready.");

        // 3. Tabla CATEGORIES
        await client.execute(`
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'categories' table ready.");

        // 4. Tabla PURCHASES
        await client.execute(`
            CREATE TABLE IF NOT EXISTS purchases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                total_price REAL NOT NULL,
                status TEXT DEFAULT 'Pendiente' NOT NULL,
                delivery_address TEXT,
                purchase_date DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'purchases' table ready.");

        // 5. Tabla WITHDRAWALS
        await client.execute(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                status TEXT DEFAULT 'Pendiente' NOT NULL,
                requested_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'withdrawals' table ready.");
        
        // 6. Tabla TRANSACTION_LOGS
        await client.execute(`
            CREATE TABLE IF NOT EXISTS transaction_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                amount REAL NOT NULL,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'transaction_logs' table ready.");

    } catch (error) {
        console.error("❌ Error initializing database:", error);
    }
}

/**
 * Inserta un usuario administrador si no existe o actualiza sus credenciales si ya existe.
 */
export async function seedAdminUser() {
    const adminEmail = process.env.VITE_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin928$%%%3_Xos923__s%%@gmail.com'; 
    const adminPassword = process.env.VITE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'adminmelu31222121'; 
    const adminReferralCode = 'ADM001'; 
    
    const hashedPassword = await bcrypt.hash(adminPassword, 10); 

    try {
        const check = await client.execute({
            sql: 'SELECT id FROM users WHERE email = ?',
            args: [adminEmail]
        });

        if (check.rows.length === 0) {
            // 1. SEMBRAR
            await client.execute({
                sql: `INSERT INTO users (username, email, phone, password_hash, plain_password, role, referral_code) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                args: ['AdminMelu', adminEmail, '5551234567', hashedPassword, adminPassword, 'Admin', adminReferralCode]
            });
            console.log(`✅ Admin user created with email: ${adminEmail}.`);
        } else {
            // 2. ACTUALIZAR
             await client.execute({
                sql: `UPDATE users SET password_hash = ?, plain_password = ?, referral_code = ? WHERE email = ?`,
                args: [hashedPassword, adminPassword, adminReferralCode, adminEmail]
            });
            console.log("✅ Admin user credentials updated/ensured.");
        }
    } catch (error) {
        console.error("❌ Error seeding/updating admin user:", error);
    }
}

/**
 * 🟢 FUNCIÓN DE MIGRACIÓN: Asignar códigos de referido a usuarios existentes sin uno
 */
export async function assignReferralCodesToExistingUsers() {
    try {
        console.log("🟡 Database: Checking for users without personal referral codes...");
        
        const usersWithoutCode = await client.execute(`
            SELECT id, username FROM users WHERE referral_code IS NULL OR referral_code = ''
        `);

        if (usersWithoutCode.rows.length === 0) {
            console.log("✅ Database: All existing users have referral codes.");
            return;
        }

        console.log(`🟡 Database: Found ${usersWithoutCode.rows.length} users requiring a referral code.`);

        for (const user of usersWithoutCode.rows) {
            let uniqueCode = '';
            let isUnique = false;
            let attempts = 0;
            
            while (!isUnique && attempts < 5) {
                uniqueCode = generateRandomCode(6);
                const existingCode = await client.execute({
                    sql: 'SELECT id FROM users WHERE referral_code = ?',
                    args: [uniqueCode]
                });
                if (existingCode.rows.length === 0) isUnique = true;
                attempts++;
            }

            if (isUnique) {
                await client.execute({
                    sql: 'UPDATE users SET referral_code = ? WHERE id = ?',
                    args: [uniqueCode, user.id]
                });
            }
        }
        console.log("✅ Database: Referral codes assigned to missing users.");

    } catch (error) {
        console.error("❌ Error assigning referral codes to existing users:", error);
    }
}