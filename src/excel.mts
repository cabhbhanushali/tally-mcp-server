import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// xlsx is a CommonJS package; under NodeNext ESM a namespace import does not expose
// its functions as callables, so load it through createRequire to get the real exports.
const require = createRequire(import.meta.url);
const XLSX: any = require('xlsx');

/* Parses an Excel (.xlsx/.xls) or CSV file of accounting-voucher lines into grouped
 * voucher objects ready for posting via the voucher-create push template.
 *
 * Expected columns (header names are case/space/underscore-insensitive):
 *   voucher_id   - group key: all rows sharing a value form ONE voucher (required)
 *   date         - voucher date (YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY or an Excel date)
 *   voucher_type - Journal / Payment / Receipt / Contra / Sales / Purchase ...
 *   ledger       - ledger name for this line
 *   debit        - debit amount (blank if this line is a credit)
 *   credit       - credit amount (blank if this line is a debit)
 *   party_ledger - (optional) voucher party ledger
 *   narration    - (optional) voucher narration
 *   reference    - (optional) voucher reference / bill number
 *   voucher_number - (optional) manual voucher number
 */

export interface ParsedEntry { ledger: string; amount: number; isDebit: boolean; }
export interface ParsedVoucher {
    voucherId: string;
    date: string;            // YYYY-MM-DD
    voucherType: string;
    partyLedger?: string;
    narration?: string;
    reference?: string;
    voucherNumber?: string;
    entries: ParsedEntry[];
    debitTotal: number;
    creditTotal: number;
    balanced: boolean;
}
export interface ExcelParseResult { vouchers: ParsedVoucher[]; errors: string[]; }

const HEADER_ALIASES: Record<string, string> = {
    voucherid: 'voucherId', vchid: 'voucherId', groupid: 'voucherId', id: 'voucherId', entryid: 'voucherId',
    date: 'date', voucherdate: 'date', vchdate: 'date',
    vouchertype: 'voucherType', type: 'voucherType', vchtype: 'voucherType',
    ledger: 'ledger', ledgername: 'ledger', account: 'ledger', accountname: 'ledger', particulars: 'ledger',
    debit: 'debit', dr: 'debit', debitamount: 'debit',
    credit: 'credit', cr: 'credit', creditamount: 'credit',
    party: 'partyLedger', partyledger: 'partyLedger', partyname: 'partyLedger',
    narration: 'narration', remarks: 'narration', description: 'narration', particularsnote: 'narration',
    reference: 'reference', ref: 'reference', billno: 'reference', billnumber: 'reference', invoiceno: 'reference',
    vouchernumber: 'voucherNumber', vchno: 'voucherNumber', voucherno: 'voucherNumber'
};

const normHeader = (h: string): string => String(h ?? '').trim().toLowerCase().replace(/[\s_\-.]+/g, '');

function toNumber(v: any): number {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[,\s₹]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

function toISODate(v: any): string | null {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) {
        const y = v.getFullYear(), mo = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
        return `${y}-${mo}-${d}`;
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/); // DD-MM-YYYY or DD/MM/YYYY
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
}

export function parseVoucherWorkbook(filePath: string, sheetName?: string): ExcelParseResult {
    const result: ExcelParseResult = { vouchers: [], errors: [] };

    if (!fs.existsSync(filePath)) {
        result.errors.push(`File not found: ${filePath}`);
        return result;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
        result.errors.push(`Unsupported file type ${ext}. Use .xlsx, .xls or .csv`);
        return result;
    }

    let rows: Record<string, any>[];
    try {
        const wb = XLSX.readFile(filePath, { cellDates: true });
        const sheet = wb.Sheets[sheetName || wb.SheetNames[0]];
        if (!sheet) {
            result.errors.push(`Sheet ${sheetName || wb.SheetNames[0]} not found`);
            return result;
        }
        rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Record<string, any>[];
    } catch (err) {
        result.errors.push(`Failed to read workbook: ${err instanceof Error ? err.message : String(err)}`);
        return result;
    }
    if (!rows.length) {
        result.errors.push('No data rows found');
        return result;
    }

    // map raw headers to canonical field names
    const rawHeaders = Object.keys(rows[0]);
    const headerMap = new Map<string, string>();
    for (const h of rawHeaders) {
        const canon = HEADER_ALIASES[normHeader(h)];
        if (canon) headerMap.set(h, canon);
    }
    const canonFields = new Set(headerMap.values());
    for (const req of ['voucherId', 'date', 'voucherType', 'ledger']) {
        if (!canonFields.has(req)) {
            result.errors.push(`Missing required column for "${req}" (accepted headers include voucher_id, date, voucher_type, ledger, debit, credit)`);
        }
    }
    if (result.errors.length) return result;

    // group rows by voucherId preserving order
    const groups = new Map<string, Record<string, any>[]>();
    rows.forEach((raw, i) => {
        const rec: Record<string, any> = {};
        for (const [rawKey, canon] of headerMap) rec[canon] = raw[rawKey];
        rec.__row = i + 2; // 1-based + header
        const id = String(rec.voucherId ?? '').trim();
        if (!id) { result.errors.push(`Row ${rec.__row}: blank voucher_id`); return; }
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id)!.push(rec);
    });

    for (const [id, grp] of groups) {
        const first = grp[0];
        const date = toISODate(first.date);
        if (!date) { result.errors.push(`Voucher ${id}: invalid or missing date "${first.date}"`); continue; }
        const voucherType = String(first.voucherType ?? '').trim();
        if (!voucherType) { result.errors.push(`Voucher ${id}: missing voucher_type`); continue; }

        const entries: ParsedEntry[] = [];
        let dr = 0, cr = 0;
        let bad = false;
        for (const r of grp) {
            const ledger = String(r.ledger ?? '').trim();
            const debit = toNumber(r.debit);
            const credit = toNumber(r.credit);
            if (!ledger) { result.errors.push(`Row ${r.__row} (voucher ${id}): blank ledger`); bad = true; break; }
            if (debit > 0 && credit > 0) { result.errors.push(`Row ${r.__row} (voucher ${id}): both debit and credit set`); bad = true; break; }
            if (debit === 0 && credit === 0) { result.errors.push(`Row ${r.__row} (voucher ${id}): both debit and credit are zero`); bad = true; break; }
            const isDebit = debit > 0;
            const amount = isDebit ? debit : credit;
            entries.push({ ledger, amount, isDebit });
            if (isDebit) dr += amount; else cr += amount;
        }
        if (bad) continue;
        if (entries.length < 2) { result.errors.push(`Voucher ${id}: needs at least 2 ledger lines`); continue; }

        result.vouchers.push({
            voucherId: id, date, voucherType,
            partyLedger: first.partyLedger ? String(first.partyLedger).trim() : undefined,
            narration: first.narration ? String(first.narration).trim() : undefined,
            reference: first.reference ? String(first.reference).trim() : undefined,
            voucherNumber: first.voucherNumber ? String(first.voucherNumber).trim() : undefined,
            entries,
            debitTotal: Math.round(dr * 100) / 100,
            creditTotal: Math.round(cr * 100) / 100,
            balanced: Math.abs(dr - cr) <= 0.01
        });
    }
    return result;
}

/* Writes an array of row objects to a .csv or .xlsx file on disk. Used by the export-to-file
 * tool to hand a cached report table off to Python / Excel. Creates the parent folder if needed.
 * Returns the absolute path written and the row/column counts. */
export function exportRowsToFile(filePath: string, rows: any[], fileFormat?: 'csv' | 'xlsx'): { path: string; rows: number; columns: number } {
    const ext = (fileFormat || path.extname(filePath).replace('.', '').toLowerCase() || 'csv') as string;
    const dir = path.dirname(filePath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const columns = rows.length ? Object.keys(rows[0]) : [];

    if (ext === 'xlsx' || ext === 'xls') {
        const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Data');
        XLSX.writeFile(wb, filePath);
    } else {
        // CSV with a UTF-8 BOM so Excel opens Unicode cleanly
        const esc = (v: any): string => {
            const s = v === null || v === undefined ? '' : String(v);
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        let csv = columns.map(esc).join(',') + '\r\n';
        for (const r of rows) csv += columns.map(c => esc(r[c])).join(',') + '\r\n';
        fs.writeFileSync(filePath, '﻿' + csv, 'utf8');
    }
    return { path: filePath, rows: rows.length, columns: columns.length };
}
