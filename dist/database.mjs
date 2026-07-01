import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
const pg = await PGlite.create('memory://');
const PG_DATE_OID = 1082;
const PG_NUMERIC_OID = 1700;
// cached tables live 60 minutes (raised from 15) so multi-step reconciliations do not
// have to re-pull mid-analysis
const TABLE_TTL_MS = 60 * 60 * 1000;
// remembers the column names/types of each cached table so callers can discover the
// schema (avoids "Referenced column X not found" guessing in query-database)
const tableSchemas = new Map();
export function getTableColumns(tableId) {
    return tableSchemas.get(tableId);
}
export function listCachedTables() {
    return Array.from(tableSchemas.entries()).map(([tableId, cols]) => ({ tableId, columns: cols.map(c => c.name) }));
}
// Returns every row of a cached table as an array of objects (column-ordered keys).
// Guards the tableId against the known-table registry so only internally-generated ids are queried.
export async function fetchTableRows(tableId) {
    if (!tableSchemas.has(tableId))
        throw new Error(`No cached table ${tableId} (it may have expired). Re-run the tool that produced it.`);
    const json = await executeSQL(`SELECT * FROM ${tableId}`, 'JSON Array of Objects');
    return JSON.parse(json);
}
const generateRandomString = () => {
    return 't_' + crypto.randomUUID().replace(/-/g, '');
};
export async function cacheTable(lstColumnMetadata, data) {
    try {
        // no table to be created if no data is found
        if (!data || data.length === 0)
            return '';
        // generate a random table name
        const tableId = generateRandomString();
        // Quote a PostgreSQL identifier to prevent injection via column names
        const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;
        let sqlCreateTable = `CREATE TABLE ${tableId} (`;
        // iterate through each column to create table schema columns
        for (const [colName, colType] of lstColumnMetadata) {
            let sqlDataType = '';
            if (colType === 'number' || colType === 'amount' || colType === 'quantity' || colType === 'rate')
                sqlDataType = 'NUMERIC(18,4)';
            else if (colType === 'boolean')
                sqlDataType = 'BOOLEAN';
            else if (colType === 'date')
                sqlDataType = 'DATE';
            else
                sqlDataType = 'TEXT';
            sqlCreateTable += `${quoteIdent(colName)} ${sqlDataType}, `;
        }
        sqlCreateTable = sqlCreateTable.slice(0, -2); // remove trailing comma
        sqlCreateTable += `);`;
        await pg.exec(sqlCreateTable);
        // remember the schema for discovery via describe-table
        tableSchemas.set(tableId, Array.from(lstColumnMetadata.entries()).map(([name, type]) => ({ name, type })));
        // iterate through each row to insert data
        const colNames = Array.from(lstColumnMetadata.keys()).map(quoteIdent).join(', ');
        const placeholders = Array.from(lstColumnMetadata.keys()).map((_, i) => `$${i + 1}`).join(', ');
        const insertSQL = `INSERT INTO ${tableId} (${colNames}) VALUES (${placeholders})`;
        await pg.transaction(async (tx) => {
            for (const row of data) {
                const values = Array.from(lstColumnMetadata.entries()).map(([colName, colType]) => {
                    const value = row[colName];
                    if (colType === 'number' || colType === 'amount' || colType === 'quantity' || colType === 'rate') {
                        return !isNaN(value) ? Number(value) : null;
                    }
                    else if (colType === 'boolean') {
                        return typeof value === 'boolean' ? value : null;
                    }
                    else if (colType === 'date') {
                        // Insert as a bare local YYYY-MM-DD string so PGlite does not apply a
                        // timezone shift (a local-midnight Date converts to the previous day in UTC
                        // for timezones ahead of UTC e.g. IST, which would move every date back a day)
                        if (value instanceof Date) {
                            const y = value.getFullYear();
                            const mo = String(value.getMonth() + 1).padStart(2, '0');
                            const d = String(value.getDate()).padStart(2, '0');
                            return `${y}-${mo}-${d}`;
                        }
                        return null;
                    }
                    else {
                        return value || '';
                    }
                });
                await tx.query(insertSQL, values);
            }
        });
        // drop the table (and forget its schema) after the TTL
        setTimeout(async () => { await pg.exec(`DROP TABLE IF EXISTS ${tableId};`); tableSchemas.delete(tableId); }, TABLE_TTL_MS);
        return tableId;
    }
    catch (err) {
        console.error(err);
        throw err;
    }
}
export async function executeSQL(sql, format = 'JSON Array of Objects') {
    try {
        // Strip comments, then enforce SELECT-only to prevent data modification or DDL injection
        const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim();
        if (!/^select\b/i.test(stripped))
            throw new Error('Only SELECT queries are permitted');
        const result = await pg.query(sql, [], { rowMode: 'array' });
        const lstHeader = result.fields.map(f => f.name);
        const lstDataType = result.fields.map(f => f.dataTypeID);
        const lstData = result.rows;
        const normalizeCellValue = (cellValue, dataTypeID) => {
            if (cellValue === null || cellValue === undefined)
                return null;
            if (dataTypeID === PG_DATE_OID) {
                // PGlite returns DATE as 'YYYY-MM-DD' string; handle Date objects just in case
                if (cellValue instanceof Date)
                    return cellValue.toISOString().substring(0, 10);
                return cellValue.toString();
            }
            if (dataTypeID === PG_NUMERIC_OID) {
                // strip trailing zeros (e.g. '1.5000' -> '1.5')
                const num = parseFloat(cellValue.toString());
                if (!isNaN(num))
                    return num;
            }
            if (typeof cellValue === 'boolean')
                return cellValue;
            return cellValue.toString();
        };
        const normalizedRows = lstData.map((row) => {
            return row.map((cellValue, c) => normalizeCellValue(cellValue, lstDataType[c]));
        });
        if (format === 'CSV') {
            const escapeCSV = (value) => {
                if (/[,"\n\r]/.test(value))
                    return `"${value.replace(/"/g, '""')}"`;
                return value;
            };
            let retval = lstHeader.map((h) => escapeCSV(h)).join(',') + '\n';
            for (const row of normalizedRows) {
                const csvRow = row.map((v) => escapeCSV(v === null ? '' : v.toString())).join(',');
                retval += csvRow + '\n';
            }
            return retval.slice(0, -1);
        }
        if (format === 'Markdown Table') {
            const escapeMarkdown = (value) => value.replace(/\|/g, '\\|');
            let retval = '| ' + lstHeader.map((h) => escapeMarkdown(h)).join(' | ') + ' |\n';
            retval += '| ' + lstHeader.map(() => '---').join(' | ') + ' |\n';
            for (const row of normalizedRows) {
                const mdRow = row.map((v) => escapeMarkdown(v === null ? '' : v.toString())).join(' | ');
                retval += '| ' + mdRow + ' |\n';
            }
            return retval.slice(0, -1);
        }
        if (format === 'JSON with Schema and Rows') {
            return JSON.stringify({
                schema: result.fields.map(f => f.name),
                rows: normalizedRows
            });
        }
        // default: JSON Array of Objects
        const rowsAsObjects = normalizedRows.map((row) => {
            const item = {};
            for (let c = 0; c < lstHeader.length; c++) {
                item[lstHeader[c]] = row[c];
            }
            return item;
        });
        return JSON.stringify(rowsAsObjects);
    }
    catch (err) {
        console.error(err);
        throw err;
    }
}
//# sourceMappingURL=database.mjs.map