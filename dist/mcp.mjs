import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fetchReport, importMasters, importVouchers, renderPushTemplate, invokeTallyAction, queryCollection, renameObjectArrayProperties, fetchNestedWalk } from './tally.mjs';
import { cacheTable, executeSQL, getTableColumns, listCachedTables, fetchTableRows } from './database.mjs';
import { lstCollectionFields, lstOptionCountryState } from './definition.mjs';
import { parseVoucherWorkbook, exportRowsToFile } from './excel.mjs';
import { utility } from './utility.mjs';
dotenv.config({ override: true, quiet: true });
const lstCollections = lstCollectionFields.map((item) => item.collection);
// Tally reserved primary-group -> suggested Zoho Books account_type. _PrimaryGroup rolls every
// user group up to its nearest reserved ancestor, so custom groups are covered too.
const PL_PRIMARY_GROUPS = new Set(['Sales Accounts', 'Purchase Accounts', 'Direct Incomes', 'Direct Expenses', 'Indirect Incomes', 'Indirect Expenses', 'Income (Direct)', 'Income (Indirect)', 'Expenses (Direct)', 'Expenses (Indirect)']);
const ZOHO_ACCOUNT_TYPE_MAP = {
    'Sundry Debtors': 'accounts_receivable',
    'Sundry Creditors': 'accounts_payable',
    'Bank Accounts': 'bank',
    'Bank OD A/c': 'bank',
    'Bank OCC A/c': 'bank',
    'Cash-in-Hand': 'cash',
    'Duties & Taxes': 'other_current_liability',
    'Provisions': 'other_current_liability',
    'Current Liabilities': 'other_current_liability',
    'Suspense A/c': 'other_current_liability',
    'Loans (Liability)': 'long_term_liability',
    'Secured Loans': 'long_term_liability',
    'Unsecured Loans': 'long_term_liability',
    'Capital Account': 'equity',
    'Reserves & Surplus': 'equity',
    'Current Assets': 'other_current_asset',
    'Loans & Advances (Asset)': 'other_current_asset',
    'Branch / Divisions': 'other_current_asset',
    'Deposits (Asset)': 'other_asset',
    'Investments': 'other_asset',
    'Misc. Expenses (ASSET)': 'other_asset',
    'Stock-in-Hand': 'stock',
    'Fixed Assets': 'fixed_asset',
    'Sales Accounts': 'income',
    'Direct Incomes': 'income',
    'Income (Direct)': 'income',
    'Indirect Incomes': 'other_income',
    'Income (Indirect)': 'other_income',
    'Purchase Accounts': 'cost_of_goods_sold',
    'Direct Expenses': 'cost_of_goods_sold',
    'Expenses (Direct)': 'cost_of_goods_sold',
    'Indirect Expenses': 'expense',
    'Expenses (Indirect)': 'expense'
};
// GST state code by Tally state name (used to derive place-of-supply code for Zoho)
const GST_STATE_CODE = {
    'jammu & kashmir': '01', 'himachal pradesh': '02', 'punjab': '03', 'chandigarh': '04', 'uttarakhand': '05',
    'haryana': '06', 'delhi': '07', 'rajasthan': '08', 'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11',
    'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14', 'mizoram': '15', 'tripura': '16', 'meghalaya': '17',
    'assam': '18', 'west bengal': '19', 'jharkhand': '20', 'odisha': '21', 'chhattisgarh': '22', 'madhya pradesh': '23',
    'gujarat': '24', 'dadra & nagar haveli and daman & diu': '26', 'maharashtra': '27', 'karnataka': '29', 'goa': '30',
    'lakshadweep': '31', 'kerala': '32', 'tamil nadu': '33', 'puducherry': '34', 'andaman & nicobar': '35',
    'telangana': '36', 'andhra pradesh': '37', 'ladakh': '38'
};
function gstStateCode(stateName, gstin) {
    if (gstin && /^\d{2}/.test(gstin))
        return gstin.substring(0, 2); // GSTIN first 2 digits are authoritative
    return GST_STATE_CODE[(stateName || '').trim().toLowerCase()] || '';
}
function mapZohoAccountType(primaryGroup) {
    const pg = (primaryGroup || '').trim();
    const account_head = PL_PRIMARY_GROUPS.has(pg) ? 'Profit & Loss' : 'Balance Sheet';
    const type = ZOHO_ACCOUNT_TYPE_MAP[pg];
    if (!type) {
        // blank primary group is usually the reserved "Profit & Loss A/c" ledger (-> Zoho retained earnings/equity)
        if (pg === '')
            return { zoho_account_type: 'equity', account_head: 'Balance Sheet', confidence: 'low', note: 'no primary group (likely Profit & Loss A/c) — review' };
        return { zoho_account_type: '', account_head, confidence: 'low', note: `unmapped primary group "${pg}" — set Zoho account_type manually` };
    }
    let note = '', confidence = 'high';
    if (pg === 'Duties & Taxes') {
        note = 'GST/TDS control — in Zoho use the built-in tax accounts or output_tax/input_tax as appropriate';
        confidence = 'medium';
    }
    else if (pg === 'Suspense A/c') {
        note = 'suspense — reclassify before go-live';
        confidence = 'low';
    }
    else if (pg === 'Deposits (Asset)') {
        note = 'if realisable within 12 months use other_current_asset';
        confidence = 'medium';
    }
    else if (pg === 'Investments') {
        note = 'no dedicated Zoho investment type; other_asset';
        confidence = 'medium';
    }
    return { zoho_account_type: type, account_head, confidence, note };
}
export async function registerMcpServer() {
    const mcpServer = new McpServer({
        name: 'Tally Prime MCP Server',
        title: 'Tally Prime',
        version: '7.0.0'
    });
    mcpServer.registerTool('metadata-collection', {
        title: 'Metadata Collection',
        description: 'returns collections metadata with collection and description',
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async () => {
        const collections = lstCollectionFields.map(({ collection, description }) => ({
            collection,
            description
        }));
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(collections)
                }
            ]
        };
    });
    mcpServer.registerTool('metadata-fields', {
        title: 'Metadata Fields',
        description: 'returns fields metadata for the selected tally collection containing field name, optional description and data type which can be string, number, date or boolean',
        inputSchema: {
            collection: z.enum(lstCollections).describe('target collection to fetch field metadata')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        const fields = (lstCollectionFields.find((item) => item.collection === args.collection)?.fields ?? []).map((field) => {
            const lstFields = { ...field };
            // substitute amount, quantity and rate data types with number data type to make it more generic since these are all numeric fields
            if (lstFields.datatype === 'amount' || lstFields.datatype === 'quantity' || lstFields.datatype === 'rate') {
                lstFields.datatype = 'number';
            }
            // delete property expression from field if found
            if (lstFields.expression) {
                delete lstFields.expression;
            }
            return lstFields;
        });
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(fields)
                }
            ]
        };
    });
    mcpServer.registerTool('query-option-values', {
        title: 'Query Option Values',
        description: 'returns predefined option values or drop-down values for the fields required for master and voucher creation, it returns back object array of pre-defined values',
        inputSchema: {
            optionName: z.enum(['country-state']).describe('option name to query')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        let retval = undefined;
        if (args.optionName === 'country-state')
            retval = lstOptionCountryState;
        else {
            return {
                isError: true,
                content: [
                    {
                        type: 'text',
                        text: 'Invalid option name'
                    }
                ]
            };
        }
        ;
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(retval)
                }
            ]
        };
    });
    mcpServer.registerTool('query-database', {
        title: 'Query Database',
        description: `executes sql query on pglite postgres in-memory database for querying cached Tally Prime report data in table generated as output by other tools (in tableID property from tool output response). These tables are temporary and will be dropped after 15 minutes automatically. Use this tool to run complex analytical queries to aggregate, filter, sort results`,
        inputSchema: {
            sql: z.string().describe('SQL query to execute on pglite postgres in-memory database, only SELECT queries are allowed. UPDATE, DELETE, INSERT queries are not allowed for data safety'),
            outputFormat: z.enum(['JSON Array of Objects', 'JSON with Schema and Rows', 'CSV', 'Markdown Table']).optional().describe('optional output format, default is JSON Array of Objects. JSON Array of Objects = [{"column1": "value1", "column2": "value2"}, {...}] , JSON with Schema and Rows = {"schema": ["column1", "column2"], "rows": [["value1", "value2"], [...]]}, CSV = comma separated values with header, Markdown Table = table format with header in markdown syntax which can be directly rendered in markdown supported viewers')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        const resp = await executeSQL(args.sql, args.outputFormat || 'JSON Array of Objects');
        return {
            content: [{ type: 'text', text: resp }]
        };
    });
    mcpServer.registerTool('query-collection', {
        title: 'Query Collection',
        description: `queries a Tally Prime collection with selected fields and optional context like target company and reporting period. result is cached in pglite postgres in-memory table and returned as tableID. Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            collection: z.enum(lstCollections).describe('collection name to query, validate it using metadata-collection tool with exact collection name'),
            fields: z.array(z.string()).min(1).describe('list of field names to fetch for the selected collection. validate it using metadata-fields resource for that collection'),
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('optional from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('optional to date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const collection = args.collection.trim();
            const requestedFields = args.fields.map((field) => field.trim());
            const targetCollectionFields = lstCollectionFields.filter(p => p.collection == args.collection).map(p => p.fields)[0];
            // Validate that every requested field exists in the collection definition
            const validFieldNames = targetCollectionFields.map(f => f.name);
            const invalidFields = requestedFields.filter(f => !validFieldNames.includes(f));
            if (invalidFields.length > 0) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `The following fields do not exist in collection '${collection}': ${invalidFields.join(', ')}. Use metadata-fields resource to get valid field names.` }]
                };
            }
            const requestedFieldsMetadata = targetCollectionFields.filter(p => requestedFields.includes(p.name));
            const fromDate = args.fromDate ? new Date(args.fromDate) : undefined;
            const toDate = args.toDate ? new Date(args.toDate) : undefined;
            const result = await queryCollection(collection, requestedFields, new Map(), args.targetCompany, fromDate, toDate);
            // prepare Map of field name and data type for caching table metadata
            let fieldMetadataMap = new Map();
            requestedFieldsMetadata.forEach((field) => {
                if (field.datatype === 'amount' || field.datatype === 'quantity' || field.datatype === 'rate') {
                    fieldMetadataMap.set(field.name, 'number');
                }
                else if (field.datatype === 'date') {
                    fieldMetadataMap.set(field.name, 'date');
                }
                else if (field.datatype === 'boolean') {
                    fieldMetadataMap.set(field.name, 'boolean');
                }
                else {
                    fieldMetadataMap.set(field.name, 'string');
                }
            });
            const tableId = await cacheTable(fieldMetadataMap, result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('list-master', {
        title: 'List Masters',
        description: `fetches list of masters from Tally Prime collection e.g. group, ledger, vouchertype, unit, godown, stockgroup, stockitem, costcategory, costcentre, attendancetype, company, currency, gstin, gstclassification returns output in JSON string array in the property list`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            collection: z.enum(['group', 'ledger', 'vouchertype', 'unit', 'godown', 'stockgroup', 'stockitem', 'costcategory', 'costcentre', 'attendancetype', 'company', 'currency', 'gstin', 'gstclassification']),
            containsFilter: z.string().optional().describe('optional filter to apply on name field with contains operator to filter results with respective name value or keywords, case insensitive')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let targetCollection = lstCollections.find((item) => item.toLowerCase() === args.collection.toLowerCase());
            if (!targetCollection) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Invalid collection name' }]
                };
            }
            let lstFilters = new Map();
            if (args.containsFilter) {
                lstFilters.set('Search_Contains', `$Name CONTAINS "${args.containsFilter.replace(/"/g, '')}"`); //ensure to strip double quotes from filter value to avoid TDL syntax error
            }
            let result = await queryCollection(targetCollection, ['Name'], lstFilters, args.targetCompany);
            return {
                content: [{ type: 'text', text: JSON.stringify({ list: result.map((item) => item.Name) }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('chart-of-accounts', {
        title: 'Chart of Accounts',
        description: `fetches chart of accounts or GL hierarchy with fields ledger_name, group_name, primary_group, bs_pl, dr_cr, affects_gross_profit, sort_position. the column bs_pl will have values false = Balance Sheet / true = Profit Loss. Column dr_cr as value true = Debit / false = Credit. primary_group is the primary group of parent or group, under which ledger is nested. The columns group and parent are tree structure represented in flat format. The column affects_gross_profit has values true / false, it is used to determine if ledger under this group will affect gross profit or not. sort_position determines position or placement order with respect to items of same level for display, returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let result = await queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup', 'IsRevenue', 'IsDeemedPositive', 'AffectsGrossProfit', 'SortPosition'], new Map(), args.targetCompany);
            result = renameObjectArrayProperties(result, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['_PrimaryGroup', 'primary_group'], ['IsRevenue', 'bs_pl'], ['IsDeemedPositive', 'dr_cr'], ['AffectsGrossProfit', 'affects_gross_profit'], ['SortPosition', 'sort_position']]));
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['primary_group', 'string'], ['bs_pl', 'boolean'], ['dr_cr', 'boolean'], ['affects_gross_profit', 'boolean'], ['sort_position', 'number']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('zoho-coa-map', {
        title: 'Zoho Chart-of-Accounts Mapping',
        description: `maps every Tally ledger to a suggested Zoho Books account_type for migration. Pulls all ledgers and derives, from the Tally reserved primary group, the Zoho account_type (accounts_receivable, accounts_payable, bank, cash, other_current_asset, other_asset, fixed_asset, stock, other_current_liability, long_term_liability, equity, income, other_income, cost_of_goods_sold, expense). Fields: ledger_name, group_name, primary_group, account_head (Balance Sheet / Profit & Loss), zoho_account_type, confidence (high/medium/low), note. Turns COA mapping into a review-and-tweak step — sort by confidence to find the ledgers that need a human decision. Result cached in an in-memory table (tableID); use query-database against it. Pure logic over the ledger masters — no period needed.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const ledgers = await queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup'], new Map(), args.targetCompany);
            const rows = ledgers.map((l) => {
                const m = mapZohoAccountType(l._PrimaryGroup);
                return { ledger_name: l.Name, group_name: l.Parent, primary_group: l._PrimaryGroup, account_head: m.account_head, zoho_account_type: m.zoho_account_type, confidence: m.confidence, note: m.note };
            });
            const tableID = await cacheTable(new Map([
                ['ledger_name', 'string'], ['group_name', 'string'], ['primary_group', 'string'],
                ['account_head', 'string'], ['zoho_account_type', 'string'], ['confidence', 'string'], ['note', 'string']
            ]), rows);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID, rowCount: rows.length }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('trial-balance', {
        title: 'Trial Balance',
        description: `fetches trial balance with fields ledger_name, group_name (blank if Profit & Loss), opening_balance, net_debit, net_credit, closing_balance. opening_balance and closing_balance negative is debit and positive is credit. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date'),
            group_name: z.string().optional().describe('optional group name to filter trial balance results, validate it using list-master tool with collection as group if required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map();
            if (args.group_name) {
                lstFilters.set('Specific_Group', `$$IsEqual:$Parent:"${args.group_name}"`);
            }
            let result = await queryCollection('Ledger', ['Name', 'Parent', 'OpeningBalance', 'DebitTotals', 'CreditTotals', 'ClosingBalance'], lstFilters, args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            result = renameObjectArrayProperties(result, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['OpeningBalance', 'opening_balance'], ['DebitTotals', 'net_debit'], ['CreditTotals', 'net_credit'], ['ClosingBalance', 'closing_balance']]));
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['opening_balance', 'amount'], ['net_debit', 'amount'], ['net_credit', 'amount'], ['closing_balance', 'amount']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('profit-loss', {
        title: 'Profit and Loss',
        description: `fetches profit and loss statement with fields like ledger_name, group_name, closing_balance. closing_balance negative is debit or expense and positive is credit or income. closing stock to be treated as credit, kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. for detailed ledger level analysis call trial-balance tool, returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let result = [];
            // ledger rows
            let result_ledger = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map([['PL_Group', '$IsRevenue']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            result_ledger = renameObjectArrayProperties(result_ledger, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['ClosingBalance', 'closing_balance']]));
            // opening and closing stock row
            let result_stock = await queryCollection('Group', ['Name', 'OpeningBalance', 'ClosingBalance'], new Map([['StockTypeGroup', '$$IsEqual:$Name:"Stock-in-Hand"']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            if (result_stock.length > 0) {
                result.push({
                    ledger_name: 'Opening Stock',
                    group_name: 'Stock-in-Hand',
                    closing_balance: result_stock[0].OpeningBalance
                });
                result.push({
                    ledger_name: 'Closing Stock',
                    group_name: 'Stock-in-Hand',
                    closing_balance: -result_stock[0].ClosingBalance
                });
            }
            // merge ledger and stock results
            result.push(...result_ledger);
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['closing_balance', 'amount']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('balance-sheet', {
        title: 'Balance Sheet',
        description: `fetches balance sheet with fields like ledger_name, group_name (blank if Profit & Loss A/c), closing_balance. closing balance negative is debit or asset and positive is credit or liability. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start or from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end or to date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let result = [];
            // ledger rows
            let result_ledger = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map([['BS_Group', 'NOT $IsRevenue'], ['Excl_Stock', 'NOT $$IsGroupStock']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            result_ledger = renameObjectArrayProperties(result_ledger, new Map([['Name', 'ledger_name'], ['Parent', 'group_name'], ['ClosingBalance', 'closing_balance']]));
            result.push(...result_ledger);
            // closing stock row
            let result_stock = await queryCollection('Group', ['Name', 'ClosingBalance'], new Map([['StockTypeGroup', '$$IsEqual:$Name:"Stock-in-Hand"']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            if (result_stock.length > 0) {
                result.push({
                    ledger_name: 'Closing Stock',
                    group_name: 'Stock-in-Hand',
                    closing_balance: result_stock[0].ClosingBalance
                });
            }
            // profit loss row
            let result_pl = await queryCollection('Ledger', ['ClosingBalance'], new Map([['PL_Ledger', '$$IsEqual:$Name:"Profit & Loss A/c"']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            if (result_pl.length > 0) {
                result.push({
                    ledger_name: 'Profit & Loss A/c',
                    group_name: '',
                    closing_balance: result_pl[0].ClosingBalance
                });
            }
            let tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['closing_balance', 'amount']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('stock-summary', {
        title: 'Stock Summary',
        description: `fetches stock item summary with fields stock_item_name, stock_group_name, opening_quantity, opening_value, inward_quantity, inward_value, outward_quantity, outward_value, closing_quantity, closing_value, returns output cached in pglite postgres in-memory table (specified in tableID property). synonyms (name=stock item / parent=stock group) Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start or from date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end or to date'),
            stockGroup: z.string().optional().describe('optional stock group name to filter stock summary results, validate it using list-master tool with collection as stock group if required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map();
            if (args.stockGroup) {
                lstFilters.set('Specific_StockGroup', `$$IsEqual:$Parent:"${args.stockGroup.replace(/"/g, '""')}"`);
            }
            let result = await queryCollection('StockItem', ['Name', 'Parent', 'OpeningBalance', 'OpeningValue', 'InwardQuantity', 'InwardValue', 'OutwardQuantity', 'OutwardValue', 'ClosingBalance', 'ClosingValue', 'AffectsGrossProfit', 'SortPosition'], lstFilters, args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
            result = renameObjectArrayProperties(result, new Map([['Name', 'stock_item_name'], ['Parent', 'stock_group_name'], ['OpeningBalance', 'opening_quantity'], ['OpeningValue', 'opening_value'], ['InwardQuantity', 'inward_quantity'], ['InwardValue', 'inward_value'], ['OutwardQuantity', 'outward_quantity'], ['OutwardValue', 'outward_value'], ['ClosingBalance', 'closing_quantity'], ['ClosingValue', 'closing_value']]));
            let tableID = await cacheTable(new Map([['stock_item_name', 'string'], ['stock_group_name', 'string'], ['opening_quantity', 'number'], ['opening_value', 'number'], ['inward_quantity', 'number'], ['inward_value', 'number'], ['outward_quantity', 'number'], ['outward_value', 'number'], ['closing_quantity', 'number'], ['closing_value', 'number']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('ledger-balance', {
        title: 'Ledger Balance',
        description: `fetches ledger closing balance as on date, negative is debit and positive is credit, display Dr for Debit or Cr for Credit after the amount for better readability, instead of negative amount flip Debit or Credit to make it positive`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            ledgerName: z.string().describe('precise ledger name, always validate it using list-master tool with collection as ledger'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date for which balance is required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map([['Exact_Ledger', `$$IsEqual:$Name:"${args.ledgerName.replace(/"/g, '""')}"`]]);
            let result = await queryCollection('Ledger', ['ClosingBalance'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            if (result.length > 0) {
                return { content: [{ type: 'text', text: JSON.stringify({ amount: result[0].ClosingBalance }) }] };
            }
            else {
                return { isError: true, content: [{ type: 'text', text: 'No ledger found' }] };
            }
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('stock-item-balance', {
        title: 'Stock Item Balance',
        description: `fetches stock item remaining quantity balance as on date, tool returns quantity and unit of measurement`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            itemName: z.string().describe('precise stock item name, always validate it using list-master tool with collection as stockitem'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date for which balance is required')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map([['Exact_StockItem', `$$IsEqual:$Name:"${args.itemName.replace(/"/g, '""')}"`]]);
            let result = await queryCollection('StockItem', ['ClosingBalance', 'Unit'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            return {
                content: [{ type: 'text', text: JSON.stringify(result.length ? { quantity: result[0].ClosingBalance, unit_of_measurement: result[0].Unit } : '') }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('bills-outstanding', {
        title: 'Bills Outstanding',
        description: `fetches pending overdue outstanding bills receivable or payable as on date with fields bill_date,reference_number,outstanding_amount,party_name,overdue_days,due_date,party_gstin. outstanding_amount = Debit is negative and Credit is positive. party_name = ledger_name. due_date = bill date + credit period (for Zoho opening invoice/bill). party_gstin = GSTIN of the party (for Zoho AR/AP contact mapping). returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            nature: z.enum(['receivable', 'payable']),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let lstFilters = new Map();
            if (args.nature) {
                lstFilters.set('Nature', `$$IsEqual:($_PrimaryGroup:Group:($Parent:Ledger:$Parent)):"${args.nature === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'}"`);
            }
            let result = await queryCollection('Bill', ['BillDate', 'Name', 'ClosingBalance', 'Parent', '_OverDueDays', 'DueDate', 'BillPartyGSTIN'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            result = renameObjectArrayProperties(result, new Map([['BillDate', 'bill_date'], ['Name', 'reference_number'], ['ClosingBalance', 'outstanding_amount'], ['Parent', 'party_name'], ['_OverDueDays', 'overdue_days'], ['DueDate', 'due_date'], ['BillPartyGSTIN', 'party_gstin']]));
            let tableID = await cacheTable(new Map([['bill_date', 'date'], ['reference_number', 'string'], ['outstanding_amount', 'number'], ['party_name', 'string'], ['overdue_days', 'number'], ['due_date', 'date'], ['party_gstin', 'string']]), result);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('ledger-closing-balances', {
        title: 'Ledger Closing Balances (as on date)',
        description: `fetches the closing balance of every ledger AS ON a single date, ready for a Tally-to-Zoho opening-balance migration — one call, no period math. Fields: ledger_name, group_name, primary_group (Tally reserved group e.g. Sundry Debtors), account_head (Balance Sheet / Profit & Loss), closing_balance (debit negative / credit positive), dr_cr (Dr / Cr). Set level='primary_group' to instead get control totals per primary group (AR / AP / Bank / Duties & Taxes etc.) — ideal for tying the migrated opening balances group-wise. Result cached in an in-memory table (tableID); use query-database against it.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as-on date YYYY-MM-DD (the migration cut-off)'),
            level: z.enum(['ledger', 'primary_group']).optional().describe("output granularity: 'ledger' (default, one row per ledger) or 'primary_group' (control totals per reserved group)")
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const ledgers = await queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup', 'ClosingBalance'], new Map(), args.targetCompany, undefined, new Date(args.toDate));
            const detail = ledgers.map((l) => {
                const bal = typeof l.ClosingBalance === 'number' && !isNaN(l.ClosingBalance) ? l.ClosingBalance : 0;
                const m = mapZohoAccountType(l._PrimaryGroup);
                return { ledger_name: l.Name, group_name: l.Parent, primary_group: l._PrimaryGroup, account_head: m.account_head, closing_balance: bal, dr_cr: bal < 0 ? 'Dr' : (bal > 0 ? 'Cr' : '') };
            });
            if (args.level === 'primary_group') {
                const agg = new Map();
                for (const r of detail) {
                    const k = r.primary_group || '(none)';
                    const e = agg.get(k) || { primary_group: k, account_head: r.account_head, closing_balance: 0, ledger_count: 0 };
                    e.closing_balance += r.closing_balance;
                    e.ledger_count += 1;
                    agg.set(k, e);
                }
                const rows = Array.from(agg.values()).map(e => ({ ...e, dr_cr: e.closing_balance < 0 ? 'Dr' : (e.closing_balance > 0 ? 'Cr' : '') }));
                const tableID = await cacheTable(new Map([['primary_group', 'string'], ['account_head', 'string'], ['closing_balance', 'amount'], ['dr_cr', 'string'], ['ledger_count', 'number']]), rows);
                return { content: [{ type: 'text', text: JSON.stringify({ tableID, rowCount: rows.length, level: 'primary_group' }) }] };
            }
            const tableID = await cacheTable(new Map([['ledger_name', 'string'], ['group_name', 'string'], ['primary_group', 'string'], ['account_head', 'string'], ['closing_balance', 'amount'], ['dr_cr', 'string']]), detail);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID, rowCount: detail.length, level: 'ledger' }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('party-balances', {
        title: 'Party Balances (debtors / creditors, advance-aware)',
        description: `fetches the closing balance of every Sundry Debtor and Sundry Creditor ledger AS ON a date, flagging likely ADVANCE ledgers so you can net advance-vs-bill the way Tally does but Zoho does not (the #1 recurring AR/AP migration diff). Fields: ledger_name, primary_group (Sundry Debtors / Sundry Creditors), group_name, closing_balance (debit negative / credit positive), dr_cr, is_advance (Yes when the ledger name/group looks like an advance account), party_base (best-effort base party name with the advance token stripped — GROUP BY this in query-database to get the net per party, then eyeball the pairings since naming is client-specific). Optionally restrict with nature. Result cached in an in-memory table (tableID); use query-database against it.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as-on date YYYY-MM-DD'),
            nature: z.enum(['receivable', 'payable', 'both']).optional().describe("'receivable' (Sundry Debtors), 'payable' (Sundry Creditors) or 'both' (default)")
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const nature = args.nature || 'both';
            let filterExpr = '';
            if (nature === 'receivable')
                filterExpr = '$$IsEqual:$_PrimaryGroup:"Sundry Debtors"';
            else if (nature === 'payable')
                filterExpr = '$$IsEqual:$_PrimaryGroup:"Sundry Creditors"';
            else
                filterExpr = '$$IsEqual:$_PrimaryGroup:"Sundry Debtors" OR $$IsEqual:$_PrimaryGroup:"Sundry Creditors"';
            const lstFilters = new Map([['PartyGroup', filterExpr]]);
            const ledgers = await queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup', 'ClosingBalance'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
            const advRe = /(^|[\s_\-])(advance|adv|advances)([\s_\-]|$)/i;
            const rows = ledgers.map((l) => {
                const bal = typeof l.ClosingBalance === 'number' && !isNaN(l.ClosingBalance) ? l.ClosingBalance : 0;
                const name = l.Name || '';
                const grp = l.Parent || '';
                const isAdvance = advRe.test(name) || /advance/i.test(grp);
                const party_base = isAdvance ? name.replace(advRe, ' ').replace(/\s+/g, ' ').trim() : name;
                return { ledger_name: name, primary_group: l._PrimaryGroup, group_name: grp, closing_balance: bal, dr_cr: bal < 0 ? 'Dr' : (bal > 0 ? 'Cr' : ''), is_advance: isAdvance ? 'Yes' : 'No', party_base };
            });
            const tableID = await cacheTable(new Map([['ledger_name', 'string'], ['primary_group', 'string'], ['group_name', 'string'], ['closing_balance', 'amount'], ['dr_cr', 'string'], ['is_advance', 'string'], ['party_base', 'string']]), rows);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID, rowCount: rows.length, advanceLedgers: rows.filter(r => r.is_advance === 'Yes').length }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('ledger-account', {
        title: 'Ledger Account',
        description: `fetches GL ledger account statement with voucher level details containing fields guid, date, voucher_type, voucher_number, alternate_ledger, party_name, amount, narration . amount = debit is negative and credit is positive. alternate_ledger = if amount is credit then ledger by which it is debited and vice-a-versa (in case of multiple ledgers first one is displayed). returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            ledgerName: z.string().describe('ledger name, always verify if ledger exists using list-master tool with collection as ledger'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['ledgerName', args.ledgerName]]);
        if (args.targetCompany) {
            inputParams.set('targetCompany', args.targetCompany);
        }
        // verify if ledger exists before making report call to avoid unnecessary processing and load on Tally
        let lstLedger = await queryCollection('Ledger', ['Name'], new Map([['Exact_Ledger', `$$IsEqual:$Name:"${args.ledgerName.replace(/"/g, '""')}"`]]), args.targetCompany);
        if (lstLedger.length === 0) {
            return {
                isError: true,
                content: [{ type: 'text', text: 'No ledger found with the given name' }]
            };
        }
        const resp = await fetchReport('ledger-account', inputParams);
        if (resp.error) {
            return {
                isError: true,
                content: [{ type: 'text', text: resp.error }]
            };
        }
        else {
            //swap opening balance row to the top since it came at the end from Tally XML response
            if (Array.isArray(resp.data) && resp.data.length > 0) {
                const lastItem = resp.data.pop();
                resp.data.unshift(lastItem);
            }
            const tableId = await cacheTable(new Map([['guid', 'string'], ['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['alternate_ledger', 'string'], ['party_name', 'string'], ['amount', 'number'], ['narration', 'string']]), resp.data);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
            };
        }
    });
    mcpServer.registerTool('stock-item-account', {
        title: 'Stock Item Account',
        description: `fetches GL stock item account statement with voucher level details containing fields date, voucher_type, voucher_number, party_name, quantity, amount, narration, tracking_number, voucher_category. party_name = ledger_name. quantity = inward as positive and outward as negative. amount = debit is negative and credit is positive, narration = notes / remarks. for calculating closing balance of quantity, consider rows with tracking_number as empty as it is, but for rows with tracking_number having text value, then duplicate rows need to be removed by preparing intermediate output with aggregation of tracking_number and voucher_category with sum of quantity and then comparing quantity of Receipt Note with Purchase and Delivery Note with Sales to identify and remove the rows with Receipt Note and Delivery Note if they are found to be tracked fully / partially . returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            itemName: z.string().describe('stock item name, validate it using list-master tool with collection as stockitem'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('from or start date'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('to or end date')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['itemName', args.itemName]]);
        if (args.targetCompany) {
            inputParams.set('targetCompany', args.targetCompany);
        }
        // verify if stock item exists before making report call to avoid unnecessary processing and load on Tally
        let lstStockItem = await queryCollection('StockItem', ['Name'], new Map([['Exact_StockItem', `$$IsEqual:$Name:"${args.itemName.replace(/"/g, '""')}"`]]), args.targetCompany);
        if (lstStockItem.length === 0) {
            return {
                isError: true,
                content: [{ type: 'text', text: 'No stock item found with the given name' }]
            };
        }
        const resp = await fetchReport('stock-item-account', inputParams);
        if (resp.error) {
            return {
                isError: true,
                content: [{ type: 'text', text: resp.error }]
            };
        }
        else {
            //swap opening balance row to the top since it came at the end from Tally XML response
            if (Array.isArray(resp.data) && resp.data.length > 0) {
                const lastItem = resp.data.pop();
                resp.data.unshift(lastItem);
            }
            const tableId = await cacheTable(new Map([['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['party_ledger', 'string'], ['quantity', 'number'], ['amount', 'number'], ['narration', 'string'], ['tracking_number', 'string'], ['voucher_category', 'string']]), resp.data);
            return {
                content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
            };
        }
    });
    mcpServer.registerTool('ledger-create-update', {
        title: 'Create or Update Ledger',
        description: `create or update ledger master data in Tally Prime, returns success count of created and / or altered records`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
            masters: z.array(z.object({
                name: z.string().describe('ledger name or updated ledger name for modify / update'),
                _name: z.string().optional().describe('old ledger name to modify / update, validate if ledger exists using list-master tool with collection as ledger'),
                parent: z.string().optional().describe('group name for the ledger, validate if group exists using list-master tool with collection as group'),
                openingBalance: z.number().optional().describe('optional opening balance for the ledger debit is negative and credit is positive'),
                isBillWise: z.boolean().optional().describe('optional billwise or bill by bill tracking is enabled for the ledger, default is false, set it undefined to keep it unchanged'),
                billCreditPeriod: z.number().optional().describe('optional bill credit period in number of days, applicable only if isBillWise is true, set it undefined to keep it unchanged'),
                mailingDetails: z.object({
                    name: z.string().optional().describe('business name for mailing details, set it undefined to keep it unchanged, set it blank to reset it to Not Applicable'),
                    country: z.string().describe('country for mailing details, validate it using query-option-values tool with input optionName as country-state, set it blank to reset it to Not Applicable'),
                    state: z.string().describe('state for mailing details, validate it using query-option-values tool with input optionName as country-state, set it blank to reset it to Not Applicable'),
                    address: z.string().optional().describe('address for mailing details, set it blank to reset it'),
                    pincode: z.string().regex(/^\d{6}$/).optional().describe('pincode for mailing details 6 digit number, set it blank to reset it, set it undefined to keep it unchanged'),
                }).optional().describe('optional mailing details for the ledger'),
                gstRegistrationDetails: z.object({
                    gstin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('GSTIN or GST number'),
                    registrationType: z.enum(['Composition', 'Regular', 'Unregistered/Consumer', 'Government entity / TDS', 'Regular - SEZ', 'Regular-Deemed Exporter', 'Regular-Exports (EOU)', 'e-Commerce Operator', 'Input Service Distributor', 'Embassy/UN Body', 'Non-Resident Taxpayer']).optional().describe('GST registration type'),
                    placeOfSupply: z.string().optional().describe('place of supply for GST, validate it using query-option-values tool with input optionName as country-state with value of state property, set it blank to reset it to Not Applicable, set it undefined to keep it unchanged'),
                }).optional().describe('optional GST registration details for the ledger, applicable only if country in mailing details is India'),
            })).describe('array of master data objects to create or update'),
        },
        annotations: {
            readOnlyHint: false,
            openWorldHint: false,
            destructiveHint: true,
            idempotentHint: true
        }
    }, async (args) => {
        try {
            if (Array.isArray(args.masters) && args.masters.length > 0) {
                let objMasterInput = new Map();
                let lstObjMasters = [];
                // assign books begin from date by calling queryCollection
                let booksBeginFrom = new Date();
                const resultBooksBeginFrom = await queryCollection('Company', ['Name', 'BooksFrom', 'IsActiveCompany'], new Map());
                if (resultBooksBeginFrom.length === 0) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: 'No company found to determine books begin from date' }]
                    };
                }
                if (!args.targetCompany) { //choose Active company
                    booksBeginFrom = resultBooksBeginFrom.filter((item) => item.IsActiveCompany)[0].BooksFrom;
                }
                else { //choose specified target company
                    booksBeginFrom = resultBooksBeginFrom.filter((item) => item.Name === args.targetCompany)[0].BooksFrom;
                }
                args.masters.forEach((master) => {
                    let objLedger = {};
                    if (master._name)
                        objLedger._name = master._name;
                    if (master.name)
                        objLedger.name = master.name;
                    if (master.parent)
                        objLedger.parent = master.parent;
                    if (master.openingBalance !== undefined)
                        objLedger.openingBalance = master.openingBalance;
                    if (master.mailingDetails) {
                        objLedger.mailingDetails = master.mailingDetails;
                        objLedger.mailingDetails.applicableFrom = booksBeginFrom;
                    }
                    if (master.gstRegistrationDetails) {
                        objLedger.gstRegistrationDetails = master.gstRegistrationDetails;
                        objLedger.gstRegistrationDetails.applicableFrom = booksBeginFrom;
                    }
                    if (master.isBillWise !== undefined) {
                        objLedger.isBillWise = master.isBillWise;
                    }
                    if (master.isBillWise === true && master.billCreditPeriod !== undefined && typeof master.billCreditPeriod === 'number') {
                        let creditDays = Math.trunc(master.billCreditPeriod);
                        objLedger.billCreditPeriod = creditDays;
                    }
                    lstObjMasters.push(objLedger);
                });
                objMasterInput.set('masters', lstObjMasters);
                if (args.targetCompany) {
                    objMasterInput.set('targetCompany', args.targetCompany);
                }
                let result = await importMasters('master-ledger', objMasterInput);
                return {
                    content: [{ type: 'text', text: JSON.stringify(result) }]
                };
            }
            else {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'masters array is required with at least one master object to create or update' }]
                };
            }
        }
        catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('set-company', {
        title: 'Set Company',
        description: `sets the active company context in Tally Prime. This changes the global company context used by Tally for subsequent operations and report queries`,
        inputSchema: {
            companyName: z.string().describe('company name to set as active, validate it using list-master tool with collection as company')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let inputParams = new Map([['SVCurrentCompany', utility.String.escapeHTML(args.companyName)]]);
            await invokeTallyAction('ChangeCurrentCompany', inputParams);
            return { content: [{ type: 'text', text: JSON.stringify('OK') }] };
        }
        catch (err) {
            return {
                isError: true, content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('set-period', {
        title: 'Set Period',
        description: `sets the active reporting period in Tally Prime by specifying a from date and to date. This changes the global period context used by Tally for subsequent report queries`,
        inputSchema: {
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('start date of the period'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('end date of the period')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let _fromDate = new Date(args.fromDate);
            let _toDate = new Date(args.toDate);
            let inputParams = new Map([['SVFromDate', utility.Date.format(_fromDate, 'd-MMM-yyyy')], ['SVToDate', utility.Date.format(_toDate, 'd-MMM-yyyy')]]);
            await invokeTallyAction('Change Period', inputParams);
            return { content: [{ type: 'text', text: JSON.stringify('OK') }] };
        }
        catch (err) {
            return {
                isError: true, content: [{ type: 'text', text: JSON.stringify(err) }]
            };
        }
    });
    mcpServer.registerTool('describe-table', {
        title: 'Describe Cached Table',
        description: `returns the column names and types of a cached in-memory table (the tableID returned by report tools), or lists all live cached tables if tableID is omitted. Use this before writing a query-database SQL query to get the exact column names and avoid "Referenced column not found" errors`,
        inputSchema: {
            tableID: z.string().optional().describe('the tableID to describe. omit to list all currently cached tables and their columns')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        if (!args.tableID) {
            return { content: [{ type: 'text', text: JSON.stringify({ tables: listCachedTables() }) }] };
        }
        const cols = getTableColumns(args.tableID);
        if (!cols)
            return { isError: true, content: [{ type: 'text', text: `No cached table ${args.tableID} (it may have expired or never existed). Call describe-table with no argument to list live tables.` }] };
        return { content: [{ type: 'text', text: JSON.stringify({ tableID: args.tableID, columns: cols }) }] };
    });
    mcpServer.registerTool('company-info', {
        title: 'Company Info',
        description: `returns basic information of the open company/companies in Tally with fields company_name, financial_year_start, financial_year_end, state, state_code (GST state code), gstin (company GSTIN, may be blank), country, email. Useful to establish the correct financial year, GST place-of-supply and reporting context before running dated reports. returns JSON array of objects`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company. validate using list-master / metadata with collection Company')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let raw = await queryCollection('Company', ['Name', 'BooksFrom', 'StateName', 'CountryName', 'Email', 'GSTRegistrationNumber'], new Map(), args.targetCompany);
            let result = raw.map((r) => {
                const s = r.BooksFrom;
                let fyStart = null, fyEnd = null;
                if (s instanceof Date) {
                    fyStart = utility.Date.format(s, 'yyyy-MM-dd');
                    const e = new Date(s.getFullYear() + 1, s.getMonth(), s.getDate());
                    e.setDate(e.getDate() - 1);
                    fyEnd = utility.Date.format(e, 'yyyy-MM-dd');
                }
                const gstin = r.GSTRegistrationNumber || '';
                return { company_name: r.Name, financial_year_start: fyStart, financial_year_end: fyEnd, state: r.StateName, state_code: gstStateCode(r.StateName, gstin), gstin, country: r.CountryName, email: r.Email };
            });
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('day-book', {
        title: 'Day Book',
        description: `fetches the Day Book / voucher register (voucher level, one row per voucher) for the given period with fields date, voucher_type, voucher_number, party_ledger, amount, narration. amount = debit is negative and credit is positive (party/primary amount). Order, cancelled and optional vouchers are excluded. Pass voucherType to restrict to one type (e.g. Sales, Purchase, Payment, Receipt, Journal); skip for all. This is the most efficient way to pull a whole month of transactions in one call. For ledger-entry level detail use voucher-register. Result cached in in-memory table (tableID). Use query-database to run SQL against it`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start date YYYY-MM-DD'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end date YYYY-MM-DD'),
            voucherType: z.string().optional().describe('optional exact voucher type to filter by (e.g. Sales, Payment, Journal). validate using metadata/list-master. skip for all')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let inputParams = new Map([
                ['fromDate', args.fromDate],
                ['toDate', args.toDate],
                ['voucherType', args.voucherType || '']
            ]);
            if (args.targetCompany)
                inputParams.set('targetCompany', args.targetCompany);
            const resp = await fetchReport('day-book', inputParams);
            if (resp.error)
                return { isError: true, content: [{ type: 'text', text: resp.error }] };
            let tableID = await cacheTable(new Map([['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['party_ledger', 'string'], ['amount', 'amount'], ['narration', 'string']]), resp.data);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('voucher-register', {
        title: 'Voucher Register',
        description: `fetches the accounting register at LEDGER-ENTRY level (one row per debit/credit line of every voucher) for the given period with fields date, voucher_type, voucher_number, party_ledger, place_of_supply, ledger_name, ledger_group, amount, dr_cr, narration. amount = debit negative / credit positive; ledger_group is the group of ledger_name (e.g. Sundry Debtors, Sales Accounts, Duties & Taxes) so tax lines and taxable lines can be separated. Two uses: (1) pass voucherNumber (with voucherType) to DRILL a single voucher into all its ledger lines; (2) skip voucherNumber to pull a full period register for reconciliation or GST outward working (filter voucherType=Sales/Credit Note then group by place_of_supply + ledger_group in query-database). Order/cancelled/optional vouchers excluded. Result cached in in-memory table (tableID); use query-database against it`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start date YYYY-MM-DD'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end date YYYY-MM-DD'),
            voucherType: z.string().optional().describe('optional exact voucher type to filter by. skip for all'),
            voucherNumber: z.string().optional().describe('optional exact voucher number to drill a single voucher; usually combined with voucherType')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let inputParams = new Map([
                ['fromDate', args.fromDate],
                ['toDate', args.toDate],
                ['voucherType', args.voucherType || ''],
                ['voucherNumber', args.voucherNumber || '']
            ]);
            if (args.targetCompany)
                inputParams.set('targetCompany', args.targetCompany);
            const resp = await fetchReport('voucher-register', inputParams);
            if (resp.error)
                return { isError: true, content: [{ type: 'text', text: resp.error }] };
            const tableID = await cacheTable(new Map([['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['party_ledger', 'string'], ['place_of_supply', 'string'], ['ledger_name', 'string'], ['ledger_group', 'string'], ['amount', 'amount'], ['dr_cr', 'string'], ['narration', 'string']]), resp.data);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('voucher-bill-allocations', {
        title: 'Voucher Bill Allocations',
        description: `fetches bill-wise allocations (the Agst Ref / New Ref mapping) for every voucher in a period — one row per bill reference on each party ledger line. Fields: guid, date, voucher_type, voucher_number, party_ledger (voucher header party, may be blank), ledger (the debtor/creditor account the bill sits under — this is the effective party for the allocation), ledger_group (its group, e.g. Sundry Debtors / Sundry Creditors), bill_ref (the bill/reference name), ref_type (Agst Ref = settles an existing bill, New Ref = raises a new bill, Advance, On Account), amount (debit negative / credit positive). This is the #1 tool for mapping Tally receipts/payments to the invoices/bills they settle when migrating to Zoho. Bound by date range; optionally filter by voucherType (Tally-side) and party ledger (post-filter on the ledger column). Result cached in an in-memory table (tableID); use query-database against it (e.g. GROUP BY ledger, ref_type).`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period start date YYYY-MM-DD'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('period end date YYYY-MM-DD'),
            voucherType: z.string().optional().describe('optional exact voucher type to filter by (e.g. Receipt, Payment, Sales, Purchase, Journal). skip for all'),
            party: z.string().optional().describe('optional exact party/debtor/creditor ledger name to restrict to (matched against the ledger the bill is allocated under)')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const fields = [
                { key: 'guid', set: '$Guid', datatype: 'string' },
                { key: 'date', set: 'if $$IsEmpty:$Date then "" else $$PyrlYYYYMMDDFormat:$Date:"-"', datatype: 'date' },
                { key: 'voucher_type', set: '$VoucherTypeName', datatype: 'string' },
                { key: 'voucher_number', set: '$VoucherNumber', datatype: 'string' },
                { key: 'party_ledger', set: '$PartyLedgerName', datatype: 'string' },
                { key: 'ledger', set: '$LedgerName', datatype: 'string' },
                { key: 'ledger_group', set: '$Parent:Ledger:$LedgerName', datatype: 'string' },
                { key: 'bill_ref', set: '$Name', datatype: 'string' },
                { key: 'ref_type', set: '$BillType', datatype: 'string' },
                { key: 'amount', set: '$$StringFindAndReplace:(if $$IsDebit:$Amount then -$$NumValue:$Amount else $$NumValue:$Amount):"(-)":"-"', datatype: 'amount' }
            ];
            const filters = ['NOT $IsCancelled', 'NOT $IsOptional', '$$NumItems:AllLedgerEntries &gt; 0'];
            if (args.voucherType)
                filters.push(`$$IsEqual:$VoucherTypeName:"${esc(args.voucherType)}"`);
            let rows = await fetchNestedWalk('Voucher.AllLedgerEntries.BillAllocations', fields, filters, ['AllLedgerEntries'], { fromDate: new Date(args.fromDate), toDate: new Date(args.toDate), targetCompany: args.targetCompany });
            if (args.party) {
                const p = args.party.toLowerCase();
                rows = rows.filter(r => (r.ledger || '').toLowerCase() === p);
            }
            const tableID = await cacheTable(new Map([
                ['guid', 'string'], ['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'],
                ['party_ledger', 'string'], ['ledger', 'string'], ['ledger_group', 'string'],
                ['bill_ref', 'string'], ['ref_type', 'string'], ['amount', 'amount']
            ]), rows);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID, rowCount: rows.length }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('create-voucher', {
        title: 'Create Voucher (write)',
        description: `WRITE TOOL. Posts a new accounting voucher (Journal, Payment, Receipt, Contra, or non-inventory Sales/Purchase/Credit Note/Debit Note) to Tally. Provide the ledger lines in entries: each has ledger (exact name, validate first), amount (positive magnitude) and isDebit (true=debit / false=credit). Total debits MUST equal total credits. The voucher is stamped with a REMOTEID which is returned on success — KEEP IT, it is required to delete/amend the voucher later (a voucher without a REMOTEID cannot be removed via the API). Does NOT handle inventory/stock lines. By default runs in dryRun mode returning the XML that WOULD be posted (nothing written). Pass dryRun=false to actually post. Before bulk posting to live books, dry-run and confirm the mapping with the user first`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('voucher date YYYY-MM-DD'),
            voucherType: z.string().describe('exact voucher type name (e.g. Journal, Payment, Receipt, Contra, Sales, Purchase). validate using metadata/list-master with collection vouchertype'),
            entries: z.array(z.object({
                ledger: z.string().describe('exact ledger name'),
                amount: z.number().positive().describe('positive amount magnitude'),
                isDebit: z.boolean().describe('true = debit, false = credit')
            })).min(2).describe('two or more ledger lines; total debit must equal total credit'),
            narration: z.string().optional().describe('optional narration / remarks'),
            reference: z.string().optional().describe('optional reference / bill number'),
            voucherNumber: z.string().optional().describe('optional manual voucher number; skip to let Tally auto-number'),
            partyLedger: z.string().optional().describe('optional party ledger name (recommended for Sales/Purchase/Payment/Receipt)'),
            remoteId: z.string().optional().describe('optional explicit REMOTEID; skip to auto-generate. needed later to delete/amend'),
            forexCurrency: z.string().optional().describe('optional foreign currency symbol e.g. "$", "€" for a foreign-currency voucher. When set, each entry amount is treated as the FOREIGN amount and the base amount = amount * forexRate. Provide together with forexRate'),
            forexRate: z.number().optional().describe('optional exchange rate: base (local) units per 1 foreign unit e.g. 83 means 1 USD = 83 INR. Provide together with forexCurrency'),
            dryRun: z.boolean().optional().describe('defaults to true (preview only). set false to actually write to Tally')
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const entries = args.entries;
            const hasForex = !!args.forexCurrency && typeof args.forexRate === 'number';
            if ((!!args.forexCurrency) !== (typeof args.forexRate === 'number'))
                return { isError: true, content: [{ type: 'text', text: 'forexCurrency and forexRate must be provided together.' }] };
            const rate = args.forexRate || 1;
            // balance is checked in base currency
            let dr = 0, cr = 0;
            for (const e of entries) {
                const base = Math.abs(e.amount) * (hasForex ? rate : 1);
                if (e.isDebit)
                    dr += base;
                else
                    cr += base;
            }
            if (Math.abs(dr - cr) > 0.01)
                return { isError: true, content: [{ type: 'text', text: `Voucher is not balanced: total debit ${dr.toFixed(2)} != total credit ${cr.toFixed(2)} (base currency). Adjust entries so debits equal credits.` }] };
            const remoteId = args.remoteId || ('mcp-' + crypto.randomUUID());
            const signedEntries = entries.map(e => {
                const mag = Math.abs(e.amount);
                const signedBase = (e.isDebit ? -1 : 1) * mag * (hasForex ? rate : 1);
                let amountStr;
                if (hasForex) {
                    const signedForeign = (e.isDebit ? -1 : 1) * mag;
                    amountStr = `${signedForeign.toFixed(2)}${args.forexCurrency} @ ${rate}/${args.forexCurrency} = ${signedBase.toFixed(2)}`;
                }
                else {
                    amountStr = signedBase.toFixed(2);
                }
                return { ledger: e.ledger, isDebit: e.isDebit, amount: amountStr };
            });
            let objInput = new Map([
                ['remoteId', remoteId],
                ['voucherType', args.voucherType],
                ['date', new Date(args.date)],
                ['entries', signedEntries]
            ]);
            if (args.voucherNumber)
                objInput.set('voucherNumber', args.voucherNumber);
            if (args.partyLedger)
                objInput.set('partyLedger', args.partyLedger);
            if (args.reference)
                objInput.set('reference', args.reference);
            if (args.narration)
                objInput.set('narration', args.narration);
            if (args.targetCompany)
                objInput.set('targetCompany', args.targetCompany);
            const dryRun = args.dryRun !== false;
            if (dryRun) {
                return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, message: `Preview only, nothing written. Debit=${dr.toFixed(2)} Credit=${cr.toFixed(2)}. Set dryRun=false to post this ${args.voucherType} voucher. remoteId that will be assigned: ${remoteId}`, remoteId, xml: renderPushTemplate('voucher-create', objInput) }, null, 2) }] };
            }
            const res = await importVouchers('voucher-create', objInput);
            const ok = res.created > 0 && res.errors === 0 && res.exceptions === 0;
            return { isError: !ok, content: [{ type: 'text', text: JSON.stringify({ dryRun: false, success: ok, remoteId, created: res.created, errors: res.errors, exceptions: res.exceptions, lineErrors: res.lineErrors, note: ok ? 'Voucher posted. Store remoteId to delete/amend later.' : 'Posting failed; see lineErrors.' }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('delete-voucher', {
        title: 'Delete Voucher (write)',
        description: `WRITE TOOL. Deletes a voucher from Tally identified by its REMOTEID. This ONLY works for vouchers created with a REMOTEID (e.g. via create-voucher, which returns one). Vouchers entered manually in Tally usually have no REMOTEID and cannot be deleted through the API. Provide the same date and voucherType used when the voucher was created. By default runs in dryRun mode (returns XML only). Pass dryRun=false to actually delete`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            remoteId: z.string().describe('the REMOTEID returned by create-voucher when the voucher was posted'),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('voucher date YYYY-MM-DD (same as when created)'),
            voucherType: z.string().describe('voucher type name (same as when created, e.g. Journal)'),
            dryRun: z.boolean().optional().describe('defaults to true (preview only). set false to actually delete')
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            let objInput = new Map([
                ['remoteId', args.remoteId],
                ['voucherType', args.voucherType],
                ['date', new Date(args.date)]
            ]);
            if (args.targetCompany)
                objInput.set('targetCompany', args.targetCompany);
            const dryRun = args.dryRun !== false;
            if (dryRun) {
                return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, message: `Preview only, nothing deleted. Set dryRun=false to delete voucher with remoteId ${args.remoteId}.`, xml: renderPushTemplate('voucher-delete', objInput) }, null, 2) }] };
            }
            const res = await importVouchers('voucher-delete', objInput);
            const ok = res.deleted > 0 && res.errors === 0 && res.exceptions === 0;
            return { isError: !ok, content: [{ type: 'text', text: JSON.stringify({ dryRun: false, success: ok, deleted: res.deleted, errors: res.errors, exceptions: res.exceptions, lineErrors: res.lineErrors, note: ok ? 'Voucher deleted.' : 'Delete failed (voucher may have no REMOTEID or wrong date/type).' }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('create-invoice-voucher', {
        title: 'Create Invoice Voucher (write, inventory)',
        description: `WRITE TOOL. Posts an INVOICE-mode Sales or Purchase voucher WITH stock/inventory items and GST to Tally (the inventory counterpart of create-voucher, which is accounting-only). Provide inventoryEntries (each: stockItemName, quantity, rate, unit, and itemLedger = the sales/purchase income or expense ledger the item value posts to) and optional ledgerEntries for taxes (CGST/SGST/IGST), freight, discount or round-off (each: ledger, amount, isDebit). The party (customer for Sales / supplier for Purchase) line is computed automatically so the voucher balances: for Sales the party is debited by the invoice total, for Purchase the party is credited. Validate every stock item and ledger name with list-master first. The voucher is stamped with a REMOTEID (returned on success) so it can be deleted later via delete-voucher. dryRun defaults true (preview XML, nothing written); pass dryRun=false to post. Before bulk posting to live books, dry-run and confirm the mapping with the user first`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('voucher date YYYY-MM-DD'),
            voucherType: z.string().optional().describe('Sales (default) or Purchase, or an exact custom voucher type of that class. validate with list-master collection vouchertype'),
            partyLedger: z.string().describe('customer ledger (Sales) or supplier ledger (Purchase); exact name, validate with list-master'),
            inventoryEntries: z.array(z.object({
                stockItemName: z.string().describe('exact stock item name'),
                quantity: z.number().positive().describe('quantity (positive)'),
                rate: z.number().describe('rate per unit'),
                unit: z.string().describe('unit symbol, e.g. Nos, Kg, Pcs (must match the item base unit)'),
                itemLedger: z.string().describe('sales income ledger (Sales) or purchase expense ledger (Purchase) the item value posts to, e.g. "Sales - Inter 18% GST"')
            })).min(1).describe('one or more stock item lines'),
            ledgerEntries: z.array(z.object({
                ledger: z.string().describe('tax / freight / discount ledger name'),
                amount: z.number().positive().describe('positive amount magnitude'),
                isDebit: z.boolean().describe('true = debit, false = credit. For Sales output GST is credit (false); for Purchase input GST is debit (true)')
            })).optional().describe('optional additional ledger lines for taxes, freight, discount, round-off'),
            narration: z.string().optional().describe('optional narration'),
            reference: z.string().optional().describe('optional invoice reference / bill number'),
            voucherNumber: z.string().optional().describe('optional manual voucher number; skip to let Tally auto-number'),
            remoteId: z.string().optional().describe('optional explicit REMOTEID; skip to auto-generate'),
            dryRun: z.boolean().optional().describe('defaults to true (preview only). set false to actually write to Tally')
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const voucherType = args.voucherType || 'Sales';
            const isSales = voucherType.toLowerCase() !== 'purchase' && !/purchase|debit note/i.test(voucherType);
            const inv = args.inventoryEntries;
            const led = (args.ledgerEntries || []);
            const signOf = (n) => (n < 0 ? 'Yes' : 'No'); // negative amount = debit = deemed positive Yes
            let itemsSigned = 0;
            const items = inv.map(it => {
                const amt = it.quantity * it.rate;
                const signed = (isSales ? 1 : -1) * amt; // Sales: item credits (+); Purchase: item debits (-)
                itemsSigned += signed;
                return { stockItemName: it.stockItemName, qty: it.quantity, rate: it.rate, unit: it.unit, itemLedger: it.itemLedger, deemedPositive: signOf(signed), amountStr: signed.toFixed(2) };
            });
            let taxSigned = 0;
            const taxes = led.map(t => {
                const signed = (t.isDebit ? -1 : 1) * Math.abs(t.amount);
                taxSigned += signed;
                return { ledger: t.ledger, deemedPositive: signOf(signed), amountStr: signed.toFixed(2) };
            });
            const partySigned = -(itemsSigned + taxSigned); // balances the voucher
            const invoiceTotal = Math.abs(partySigned);
            const remoteId = args.remoteId || ('mcp-' + crypto.randomUUID());
            let objInput = new Map([
                ['remoteId', remoteId],
                ['voucherType', voucherType],
                ['date', new Date(args.date)],
                ['partyLedger', args.partyLedger],
                ['items', items],
                ['taxes', taxes],
                ['partyDeemedPositive', signOf(partySigned)],
                ['partyAmountStr', partySigned.toFixed(2)]
            ]);
            if (args.voucherNumber)
                objInput.set('voucherNumber', args.voucherNumber);
            if (args.reference)
                objInput.set('reference', args.reference);
            if (args.narration)
                objInput.set('narration', args.narration);
            if (args.targetCompany)
                objInput.set('targetCompany', args.targetCompany);
            const dryRun = args.dryRun !== false;
            if (dryRun) {
                return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, message: `Preview only, nothing written. ${voucherType} invoice, party ${signOf(partySigned) === 'Yes' ? 'debited' : 'credited'} ${invoiceTotal.toFixed(2)}. Set dryRun=false to post. remoteId that will be assigned: ${remoteId}`, remoteId, invoiceTotal, xml: renderPushTemplate('voucher-invoice', objInput) }, null, 2) }] };
            }
            const res = await importVouchers('voucher-invoice', objInput);
            const ok = res.created > 0 && res.errors === 0 && res.exceptions === 0;
            return { isError: !ok, content: [{ type: 'text', text: JSON.stringify({ dryRun: false, success: ok, remoteId, invoiceTotal, created: res.created, errors: res.errors, exceptions: res.exceptions, lineErrors: res.lineErrors, note: ok ? 'Invoice posted. Store remoteId to delete later.' : 'Posting failed; see lineErrors.' }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('import-vouchers-excel', {
        title: 'Import Vouchers from Excel/CSV (write)',
        description: `WRITE TOOL. Bulk-creates accounting vouchers from an Excel (.xlsx/.xls) or CSV file. Each row is one ledger line; rows sharing the same voucher_id form one voucher. Columns (case/space/underscore-insensitive): voucher_id (required, group key), date (required), voucher_type (required: Journal/Payment/Receipt/Contra/etc), ledger (required), debit, credit, and optional party_ledger, narration, reference, voucher_number. Each voucher must balance (total debit = total credit). Every posted voucher is stamped with a REMOTEID (returned) so it can be deleted later. Handles accounting vouchers only (no inventory; use create-invoice-voucher for stock invoices). dryRun defaults true: it parses and validates the file and returns the vouchers it WOULD post without writing anything. Pass dryRun=false to post. ALWAYS dry-run first and confirm the parsed vouchers with the user before a bulk post to live books.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            filePath: z.string().describe('absolute path to the .xlsx / .xls / .csv file'),
            sheetName: z.string().optional().describe('optional worksheet name; defaults to the first sheet'),
            dryRun: z.boolean().optional().describe('defaults to true (parse + validate + preview only). set false to actually post all balanced vouchers')
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const parsed = parseVoucherWorkbook(args.filePath, args.sheetName);
            if (parsed.errors.length && parsed.vouchers.length === 0)
                return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: parsed.errors }, null, 2) }] };
            const balanced = parsed.vouchers.filter(v => v.balanced);
            const unbalanced = parsed.vouchers.filter(v => !v.balanced).map(v => ({ voucherId: v.voucherId, debit: v.debitTotal, credit: v.creditTotal }));
            const dryRun = args.dryRun !== false;
            if (dryRun) {
                return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, message: `Parsed ${parsed.vouchers.length} voucher(s): ${balanced.length} balanced, ${unbalanced.length} unbalanced. Set dryRun=false to post the balanced ones. Nothing written yet.`, parseErrors: parsed.errors, unbalanced, vouchers: balanced.map(v => ({ voucherId: v.voucherId, date: v.date, voucherType: v.voucherType, lines: v.entries.length, debitTotal: v.debitTotal, entries: v.entries })) }, null, 2) }] };
            }
            const results = [];
            for (const v of balanced) {
                const remoteId = 'mcp-' + crypto.randomUUID();
                const signedEntries = v.entries.map(e => ({ ledger: e.ledger, isDebit: e.isDebit, amount: ((e.isDebit ? -1 : 1) * Math.abs(e.amount)).toFixed(2) }));
                const objInput = new Map([
                    ['remoteId', remoteId],
                    ['voucherType', v.voucherType],
                    ['date', new Date(v.date)],
                    ['entries', signedEntries]
                ]);
                if (v.voucherNumber)
                    objInput.set('voucherNumber', v.voucherNumber);
                if (v.partyLedger)
                    objInput.set('partyLedger', v.partyLedger);
                if (v.reference)
                    objInput.set('reference', v.reference);
                if (v.narration)
                    objInput.set('narration', v.narration);
                if (args.targetCompany)
                    objInput.set('targetCompany', args.targetCompany);
                const res = await importVouchers('voucher-create', objInput);
                const ok = res.created > 0 && res.errors === 0 && res.exceptions === 0;
                results.push({ voucherId: v.voucherId, remoteId, success: ok, created: res.created, errors: res.errors, lineErrors: res.lineErrors });
            }
            const posted = results.filter(r => r.success).length;
            return { content: [{ type: 'text', text: JSON.stringify({ dryRun: false, posted, failed: results.length - posted, skippedUnbalanced: unbalanced.length, parseErrors: parsed.errors, results }, null, 2) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('export-to-file', {
        title: 'Export Cached Table to File',
        description: `writes a cached in-memory report table (a tableID returned by any report tool) to a .csv or .xlsx file on disk, for a clean hand-off to Python / Excel during a migration. Provide the tableID and an absolute filePath; the format is inferred from the extension unless you pass format. The parent folder is created if missing and an existing file is overwritten. Returns the path written plus row/column counts.`,
        inputSchema: {
            tableID: z.string().describe('the tableID to export (from query-collection, day-book, voucher-bill-allocations, etc.). Use describe-table to list live tables'),
            filePath: z.string().describe('absolute output path, e.g. C:/Users/bhavi/Tmp/bill_allocations.csv or .xlsx'),
            format: z.enum(['csv', 'xlsx']).optional().describe('optional; inferred from the filePath extension when omitted')
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const rows = await fetchTableRows(args.tableID);
            const res = exportRowsToFile(args.filePath, rows, args.format);
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...res }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    mcpServer.registerTool('migration-audit', {
        title: 'Migration Data-Quality Audit',
        description: `scans the Tally company for the data-quality issues that most often break a Tally-to-Zoho migration and returns them as a findings table (one row per issue: category, severity, entity_type, entity_name, detail). Master checks (always run): party_no_gstin (Sundry Debtors/Creditors without a GSTIN), ledger_no_primary_group (ledger not under any reserved group), duplicate_party (near-duplicate ledger names after stripping Ltd/Pvt/punctuation), negative_stock (stock item with a negative closing quantity). Transaction check (only when fromDate+toDate are given): unlinked_allocation (receipts/payments left On Account, i.e. not settled against a bill — the advances/unadjusted items to fix before migrating). Run this before starting a migration. Result cached in an in-memory table (tableID); use query-database to slice by category/severity, and export-to-file to hand it off.`,
        inputSchema: {
            targetCompany: z.string().optional().describe('optional company name. skip for default active company'),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('optional as-on date for the negative-stock check (defaults to latest)'),
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('optional period start; provide with toDate to also run the unlinked-allocation (On Account) transaction check')
        },
        annotations: {
            readOnlyHint: true,
            openWorldHint: false
        }
    }, async (args) => {
        try {
            const findings = [];
            // --- master checks ---
            const ledgers = await queryCollection('Ledger', ['Name', '_PrimaryGroup', 'RegisteredGSTIN'], new Map(), args.targetCompany);
            for (const l of ledgers) {
                const pg = (l._PrimaryGroup || '').trim();
                if ((pg === 'Sundry Debtors' || pg === 'Sundry Creditors') && !(l.RegisteredGSTIN || '').trim())
                    findings.push({ category: 'party_no_gstin', severity: 'warning', entity_type: 'ledger', entity_name: l.Name, detail: `${pg} without GSTIN` });
                if (pg === '')
                    findings.push({ category: 'ledger_no_primary_group', severity: 'warning', entity_type: 'ledger', entity_name: l.Name, detail: 'ledger not under any reserved primary group' });
            }
            // near-duplicate party names (strip company-suffix noise + punctuation)
            const NOISE = new Set(['ltd', 'limited', 'pvt', 'private', 'llp', 'llc', 'inc', 'co', 'company', 'the', 'and', 'corporation', 'corp']);
            const normName = (n) => String(n || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t && !NOISE.has(t)).join('');
            const byNorm = new Map();
            for (const l of ledgers) {
                const k = normName(l.Name);
                if (!k)
                    continue;
                const arr = byNorm.get(k) || [];
                arr.push(l.Name);
                byNorm.set(k, arr);
            }
            for (const [k, names] of byNorm) {
                const uniq = Array.from(new Set(names));
                if (uniq.length > 1)
                    findings.push({ category: 'duplicate_party', severity: 'warning', entity_type: 'ledger', entity_name: uniq[0], detail: `possible duplicates: ${uniq.join(' | ')}` });
            }
            // negative stock
            const stock = await queryCollection('StockItem', ['Name', 'ClosingBalance'], new Map(), args.targetCompany, undefined, args.toDate ? new Date(args.toDate) : undefined);
            for (const s of stock) {
                if (typeof s.ClosingBalance === 'number' && s.ClosingBalance < 0)
                    findings.push({ category: 'negative_stock', severity: 'error', entity_type: 'stock_item', entity_name: s.Name, detail: `negative closing quantity ${s.ClosingBalance}` });
            }
            // --- transaction check (optional) ---
            if (args.fromDate && args.toDate) {
                const fields = [
                    { key: 'guid', set: '$Guid', datatype: 'string' },
                    { key: 'voucher_type', set: '$VoucherTypeName', datatype: 'string' },
                    { key: 'voucher_number', set: '$VoucherNumber', datatype: 'string' },
                    { key: 'ledger', set: '$LedgerName', datatype: 'string' },
                    { key: 'ref_type', set: '$BillType', datatype: 'string' },
                    { key: 'amount', set: '$$StringFindAndReplace:(if $$IsDebit:$Amount then -$$NumValue:$Amount else $$NumValue:$Amount):"(-)":"-"', datatype: 'amount' }
                ];
                const allocs = await fetchNestedWalk('Voucher.AllLedgerEntries.BillAllocations', fields, ['NOT $IsCancelled', 'NOT $IsOptional', '$$NumItems:AllLedgerEntries &gt; 0'], ['AllLedgerEntries'], { fromDate: new Date(args.fromDate), toDate: new Date(args.toDate), targetCompany: args.targetCompany });
                for (const a of allocs) {
                    if ((a.ref_type || '') === 'On Account')
                        findings.push({ category: 'unlinked_allocation', severity: 'warning', entity_type: 'voucher', entity_name: `${a.voucher_type} ${a.voucher_number}`, detail: `${a.ledger}: On Account ${a.amount} (not settled against a bill)` });
                }
            }
            const summary = {};
            for (const f of findings)
                summary[f.category] = (summary[f.category] || 0) + 1;
            const tableID = await cacheTable(new Map([
                ['category', 'string'], ['severity', 'string'], ['entity_type', 'string'], ['entity_name', 'string'], ['detail', 'string']
            ]), findings);
            return { content: [{ type: 'text', text: JSON.stringify({ tableID, totalFindings: findings.length, summary }) }] };
        }
        catch (err) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
        }
    });
    return mcpServer;
}
//# sourceMappingURL=mcp.mjs.map