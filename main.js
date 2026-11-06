import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { program } from 'commander';
import superagent from 'superagent';

// 1. Налаштування параметрів командного рядка
// Вимикаємо стандартний -h для help, щоб звільнити прапорець -h для --host
program
    .helpOption('--help', 'Вивести довідку')
    .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
    .requiredOption('-p, --port <number>', 'порт сервера', (val) => {
        const parsed = Number.parseInt(val, 10);
        if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
            throw new Error('Порт має бути цілим числом від 1 до 65535');
        }
        return parsed;
    })
    .requiredOption('-c, --cache <path>', 'шлях до теки з кешованими картинками');

program.parse(process.argv);
const options = program.opts();

const cacheDir = path.resolve(options.cache);

// 2. Створення теки кешу до початку приймання запитів
try {
    await fs.mkdir(cacheDir, { recursive: true });
} catch (err) {
    console.error(`Помилка створення теки кешу: ${err.message}`);
    process.exit(1);
}

// Допоміжна функція для отримання шляху до файлу кешу
function getCacheFilePath(code) {
    return path.join(cacheDir, `${code}.jpg`);
}

// Допоміжна функція для читання двійкового тіла запиту через проміси (for await...of)
async function readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// 3. Створення HTTP-сервера (єдиний дозволений колбек — async-обробник запиту)
const server = http.createServer(async (req, res) => {
    try {
        // Виділяємо шлях без query-параметрів (наприклад, "/200" -> "200")
        const urlPath = (req.url || '/').split('?')[0];
        const match = urlPath.match(/^\/(\d{3})$/);

        // Якщо шлях не відповідає тризначному коду стану HTTP — повертаємо 404
        if (!match) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Некоректний шлях. Вкажіть тризначний код стану HTTP (наприклад, /200).\n');
            return;
        }

        const statusCode = match[1];
        const filePath = getCacheFilePath(statusCode);

        // Обробка методу GET
        if (req.method === 'GET') {
            try {
                // Спроба прочитати картинку з кешу
                const cachedImage = await fs.readFile(filePath);
                res.writeHead(200, {
                    'Content-Type': 'image/jpeg',
                    'X-Cache': 'HIT',
                });
                res.end(cachedImage);
                return;
            } catch (cacheErr) {
                // Якщо файлу немає в кеші (ENOENT) — робимо запит до http.cat
                if (cacheErr.code !== 'ENOENT') {
                    throw cacheErr;
                }
            }

            try {
                const response = await superagent
                    .get(`https://http.cat/${statusCode}`)
                    .buffer(true);

                const imageBuffer = response.body;

                // 1. Спочатку зберігаємо картинку в кеш
                await fs.writeFile(filePath, imageBuffer);

                // 2. Потім пересилаємо клієнтові
                res.writeHead(200, {
                    'Content-Type': 'image/jpeg',
                    'X-Cache': 'MISS',
                });
                res.end(imageBuffer);
            } catch (fetchErr) {
                // Якщо на http.cat немає картинки або сталася помилка мережі — 404, у кеш не пишемо
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Картинку для коду ${statusCode} не знайдено ні в кеші, ні на http.cat.\n`);
            }
            return;
        }

