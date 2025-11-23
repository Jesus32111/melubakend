import { createClient } from '@libsql/client';
import 'dotenv/config';
import bcrypt from 'bcryptjs';

const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initializeDb() {
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

        // 2. Tabla PRODUCTS (Actualizada con is_deleted)
        await client.execute(`
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                platform TEXT NOT NULL,
                description TEXT,
                product_details TEXT DEFAULT NULL,
                instructions TEXT DEFAULT NULL,
                is_renewable INTEGER DEFAULT 0,
                delivery TEXT NOT NULL DEFAULT 'Automática',
                duration TEXT NOT NULL DEFAULT '30 Días',
                type TEXT NOT NULL DEFAULT 'Cuenta',
                price_standard REAL NOT NULL DEFAULT 0.00,
                price_premium REAL DEFAULT 0.00,
                price_renewal_standard REAL DEFAULT 0.00,
                price_renewal_premium REAL DEFAULT 0.00,
                image_url TEXT,
                images TEXT DEFAULT '[]',
                stock INTEGER DEFAULT 0,
                credentials TEXT DEFAULT '[]',
                provider TEXT,
                icon_name TEXT DEFAULT 'Package',
                creator_user_id INTEGER NOT NULL DEFAULT 1,
                is_published INTEGER DEFAULT 0,
                publication_end_date DATETIME DEFAULT NULL,
                is_best_seller INTEGER DEFAULT 0,
                is_offer INTEGER DEFAULT 0,
                is_trending INTEGER DEFAULT 0,
                is_deleted INTEGER DEFAULT 0, -- 🟢 NUEVO: Campo para borrado lógico
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (creator_user_id) REFERENCES users(id)
            );
        `);
        console.log("✅ Database: 'products' table ready.");

        // 3. Tabla PRODUCT_STOCK
        await client.execute(`
            CREATE TABLE IF NOT EXISTS product_stock (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                provider_user_id INTEGER NOT NULL,
                data TEXT NOT NULL, 
                is_sold INTEGER DEFAULT 0,
                sold_to_user_id INTEGER DEFAULT NULL,
                sold_at DATETIME DEFAULT NULL,
                client_name TEXT DEFAULT NULL,
                client_phone TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(id),
                FOREIGN KEY (provider_user_id) REFERENCES users(id),
                FOREIGN KEY (sold_to_user_id) REFERENCES users(id)
            );
        `);
        console.log("✅ Database: 'product_stock' table ready.");

        // 4. Tabla ORDERS
        await client.execute(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchase_id TEXT NOT NULL,
                buyer_user_id INTEGER NOT NULL,
                provider_user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                quantity INTEGER DEFAULT 1,
                total_price REAL DEFAULT 0.00,
                status TEXT DEFAULT 'Pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (buyer_user_id) REFERENCES users(id),
                FOREIGN KEY (provider_user_id) REFERENCES users(id),
                FOREIGN KEY (product_id) REFERENCES products(id)
            );
        `);
        console.log("✅ Database: 'orders' table ready.");

        // 5. Tabla CATEGORIAS
        await client.execute(`
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                logo_url TEXT
            );
        `);
        console.log("✅ Database: 'categories' table ready.");
        
        await client.execute(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount_original REAL NOT NULL, -- Monto bruto (Saldo total)
                amount_final REAL NOT NULL,    -- Monto neto (Menos 10%)
                status TEXT DEFAULT 'Pending', -- 'Pending', 'Approved', 'Rejected'
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        `);
        console.log("✅ Database: 'withdrawals' table ready.");
        
        // 🔹 SEEDING INICIAL DE CATEGORÍAS
        const catCheck = await client.execute("SELECT count(*) as count FROM categories");
        if (catCheck.rows[0].count === 0) {
            await client.execute({
                sql: `INSERT INTO categories (name, logo_url) VALUES 
                ('Netflix', 'https://images.pexels.com/photos/7991579/pexels-photo-7991579.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2'),
                ('Spotify', 'https://images.pexels.com/photos/170034/pexels-photo-170034.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2'),
                ('Disney+', 'https://images.pexels.com/photos/1036808/pexels-photo-1036808.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2'),
                ('HBO Max', 'https://images.pexels.com/photos/1036808/pexels-photo-1036808.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2')`,
                args: []
            });
            console.log("✅ Categories seeded.");
        }

        // 🟢 MIGRACIÓN AUTOMÁTICA: Agregar columna is_deleted si no existe
        // Esto evita errores si la tabla ya fue creada anteriormente sin esta columna
        try {
            await client.execute("ALTER TABLE products ADD COLUMN is_deleted INTEGER DEFAULT 0");
            console.log("✅ Columna 'is_deleted' agregada a la tabla products.");
        } catch (err) {
            // Si falla es porque ya existe, lo ignoramos silenciosamente
        }

    } catch (error) {
        console.error("❌ Error initializing database:", error);
    }
}

// --- SEEDING ADMIN ---
async function seedAdminUser() {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) return;
    try {
        const existingAdmin = await client.execute({
            sql: 'SELECT id FROM users WHERE email = ? AND role = ?',
            args: [adminEmail, 'Admin']
        });
        if (existingAdmin.rows.length === 0) {
            const salt = await bcrypt.genSalt(10);
            const password_hash = await bcrypt.hash(adminPassword, salt);
            await client.execute({
                sql: `INSERT INTO users (username, email, password_hash, referral_code, role, is_approved)
                      VALUES (?, ?, ?, ?, ?, ?)`,
                args: ['AdminUser', adminEmail, password_hash, 'ADM001', 'Admin', 1]
            });
            console.log(`👤 Admin user created: ${adminEmail}`);
        }
    } catch (error) { }
}

// 🔑 FUNCIÓN DE LIMPIEZA AUTOMÁTICA
async function cleanupDb() {
    try {
        const excludedEmails = ['admin@gmail.com', 'asd@gmail.com'];
        const excludedEmailsPlaceholder = excludedEmails.map(() => '?').join(', ');

        await client.execute('DELETE FROM orders');
        await client.execute('DELETE FROM product_stock');
        await client.execute('DELETE FROM products');

        const deleteUsersResult = await client.execute({
            sql: `DELETE FROM users WHERE email NOT IN (${excludedEmailsPlaceholder})`,
            args: excludedEmails
        });

        console.log(`🧹 Database Cleanup: ${deleteUsersResult.rowsAffected} users deleted.`);

        return {
            productsCleared: true,
            stockCleared: true,
            usersDeletedCount: deleteUsersResult.rowsAffected
        };

    } catch (error) {
        console.error("❌ Error during database cleanup:", error);
        throw new Error('Database cleanup failed.');
    }
}

export { client, initializeDb, seedAdminUser, cleanupDb };