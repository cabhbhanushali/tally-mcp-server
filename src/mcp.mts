import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fetchReport, importMasters, importVouchers, renderPushTemplate, invokeTallyAction, queryCollection, renameObjectArrayProperties } from './tally.mjs';
import { cacheTable, executeSQL } from './database.mjs';
import { lstCollectionFields, lstOptionCountryState } from './definition.mjs';
import { utility } from './utility.mjs';

dotenv.config({ override: true, quiet: true });

const lstCollections = lstCollectionFields.map((item) => item.collection);

export async function registerMcpServer(): Promise<McpServer> {
  const mcpServer = new McpServer({
    name: 'Tally Prime MCP Server',
    title: 'Tally Prime',
    version: '7.0.0'
  });


  mcpServer.registerTool(
    'metadata-collection',
    {
      title: 'Metadata Collection',
      description: 'returns collections metadata with collection and description',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => {
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
    }
  );

  mcpServer.registerTool(
    'metadata-fields',
    {
      title: 'Metadata Fields',
      description: 'returns fields metadata for the selected tally collection containing field name, optional description and data type which can be string, number, date or boolean',
      inputSchema: {
        collection: z.enum(lstCollections).describe('target collection to fetch field metadata')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const fields = (lstCollectionFields.find(
        (item) => item.collection === args.collection
      )?.fields ?? []).map((field) => {
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
    }
  );

  mcpServer.registerTool(
    'query-option-values',
    {
      title: 'Query Option Values',
      description: 'returns predefined option values or drop-down values for the fields required for master and voucher creation, it returns back object array of pre-defined values',
      inputSchema: {
        optionName: z.enum(['country-state']).describe('option name to query')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let retval = undefined;
      if (args.optionName === 'country-state') retval = lstOptionCountryState;
      else {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Invalid option name'
            }
          ]
        }
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(retval)
          }
        ]
      };
    }
  );

  mcpServer.registerTool(
    'query-database',
    {
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
    },
    async (args) => {
      const resp = await executeSQL(args.sql, args.outputFormat || 'JSON Array of Objects');
      return {
        content: [{ type: 'text', text: resp }]
      };
    }
  );

  mcpServer.registerTool(
    'query-collection',
    {
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
    },
    async (args) => {
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

        const result = await queryCollection(
          collection,
          requestedFields,
          new Map<string, string>(),
          args.targetCompany,
          fromDate,
          toDate
        );

        // prepare Map of field name and data type for caching table metadata
        let fieldMetadataMap = new Map<string, string>();
        requestedFieldsMetadata.forEach((field) => {
          if (field.datatype === 'amount' || field.datatype === 'quantity' || field.datatype === 'rate') {
            fieldMetadataMap.set(field.name, 'number');
          } else if (field.datatype === 'date') {
            fieldMetadataMap.set(field.name, 'date');
          } else if (field.datatype === 'boolean') {
            fieldMetadataMap.set(field.name, 'boolean');
          } else {
            fieldMetadataMap.set(field.name, 'string');
          }
        });

        const tableId = await cacheTable(fieldMetadataMap, result);

        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'list-master',
    {
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
    },
    async (args) => {
      try {
        let targetCollection = lstCollections.find((item) => item.toLowerCase() === args.collection.toLowerCase());
        if (!targetCollection) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Invalid collection name' }]
          }
        }
        let lstFilters = new Map<string, string>();
        if (args.containsFilter) {
          lstFilters.set('Search_Contains', `$Name CONTAINS "${args.containsFilter.replace(/"/g, '')}"`); //ensure to strip double quotes from filter value to avoid TDL syntax error
        }
        let result = await queryCollection(targetCollection, ['Name'], lstFilters, args.targetCompany);
        return {
          content: [{ type: 'text', text: JSON.stringify({ list: result.map((item) => item.Name) }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'chart-of-accounts',
    {
      title: 'Chart of Accounts',
      description: `fetches chart of accounts or GL hierarchy with fields ledger_name, group_name, primary_group, bs_pl, dr_cr, affects_gross_profit, sort_position. the column bs_pl will have values false = Balance Sheet / true = Profit Loss. Column dr_cr as value true = Debit / false = Credit. primary_group is the primary group of parent or group, under which ledger is nested. The columns group and parent are tree structure represented in flat format. The column affects_gross_profit has values true / false, it is used to determine if ledger under this group will affect gross profit or not. sort_position determines position or placement order with respect to items of same level for display, returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        let result = await queryCollection('Ledger', ['Name', 'Parent', '_PrimaryGroup', 'IsRevenue', 'IsDeemedPositive', 'AffectsGrossProfit', 'SortPosition'], new Map<string, string>(), args.targetCompany);
        result = renameObjectArrayProperties(result, new Map<string, string>([['Name', 'ledger_name'], ['Parent', 'group_name'], ['_PrimaryGroup', 'primary_group'], ['IsRevenue', 'bs_pl'], ['IsDeemedPositive', 'dr_cr'], ['AffectsGrossProfit', 'affects_gross_profit'], ['SortPosition', 'sort_position']]));
        let tableID = await cacheTable(new Map<string, string>([['ledger_name', 'string'], ['group_name', 'string'], ['primary_group', 'string'], ['bs_pl', 'boolean'], ['dr_cr', 'boolean'], ['affects_gross_profit', 'boolean'], ['sort_position', 'number']]), result);
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );


  mcpServer.registerTool(
    'trial-balance',
    {
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
    },
    async (args) => {
      try {
        let lstFilters = new Map<string, string>();
        if (args.group_name) {
          lstFilters.set('Specific_Group', `$$IsEqual:$Parent:"${args.group_name}"`);
        }
        let result = await queryCollection('Ledger', ['Name', 'Parent', 'OpeningBalance', 'DebitTotals', 'CreditTotals', 'ClosingBalance'], lstFilters, args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
        result = renameObjectArrayProperties(result, new Map<string, string>([['Name', 'ledger_name'], ['Parent', 'group_name'], ['OpeningBalance', 'opening_balance'], ['DebitTotals', 'net_debit'], ['CreditTotals', 'net_credit'], ['ClosingBalance', 'closing_balance']]));
        let tableID = await cacheTable(new Map<string, string>([['ledger_name', 'string'], ['group_name', 'string'], ['opening_balance', 'amount'], ['net_debit', 'amount'], ['net_credit', 'amount'], ['closing_balance', 'amount']]), result);
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'profit-loss',
    {
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
    },
    async (args) => {
      try {
        let result: any[] = [];
        // ledger rows
        let result_ledger = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map<string, string>([['PL_Group', '$IsRevenue']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
        result_ledger = renameObjectArrayProperties(result_ledger, new Map<string, string>([['Name', 'ledger_name'], ['Parent', 'group_name'], ['ClosingBalance', 'closing_balance']]));

        // opening and closing stock row
        let result_stock = await queryCollection('Group', ['Name', 'OpeningBalance', 'ClosingBalance'], new Map<string, string>([['StockTypeGroup', '$$IsEqual:$Name:"Stock-in-Hand"']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
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
        let tableID = await cacheTable(new Map<string, string>([['ledger_name', 'string'], ['group_name', 'string'], ['closing_balance', 'amount']]), result);
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'balance-sheet',
    {
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
    },
    async (args) => {
      try {
        let result: any[] = [];
        // ledger rows
        let result_ledger = await queryCollection('Ledger', ['Name', 'Parent', 'ClosingBalance'], new Map<string, string>([['BS_Group', 'NOT $IsRevenue'], ['Excl_Stock', 'NOT $$IsGroupStock']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
        result_ledger = renameObjectArrayProperties(result_ledger, new Map<string, string>([['Name', 'ledger_name'], ['Parent', 'group_name'], ['ClosingBalance', 'closing_balance']]));
        result.push(...result_ledger);

        // closing stock row
        let result_stock = await queryCollection('Group', ['Name', 'ClosingBalance'], new Map<string, string>([['StockTypeGroup', '$$IsEqual:$Name:"Stock-in-Hand"']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
        if (result_stock.length > 0) {
          result.push({
            ledger_name: 'Closing Stock',
            group_name: 'Stock-in-Hand',
            closing_balance: result_stock[0].ClosingBalance
          });
        }

        // profit loss row
        let result_pl = await queryCollection('Ledger', ['ClosingBalance'], new Map<string, string>([['PL_Ledger', '$$IsEqual:$Name:"Profit & Loss A/c"']]), args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
        if (result_pl.length > 0) {
          result.push({
            ledger_name: 'Profit & Loss A/c',
            group_name: '',
            closing_balance: result_pl[0].ClosingBalance
          });
        }

        let tableID = await cacheTable(new Map<string, string>([['ledger_name', 'string'], ['group_name', 'string'], ['closing_balance', 'amount']]), result);
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'stock-summary',
    {
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
    },
    async (args) => {
      try {
        let lstFilters = new Map<string, string>();
        if (args.stockGroup) {
          lstFilters.set('Specific_StockGroup', `$$IsEqual:$Parent:"${args.stockGroup.replace(/"/g, '""')}"`);
        }
        let result = await queryCollection('StockItem', ['Name', 'Parent', 'OpeningBalance', 'OpeningValue', 'InwardQuantity', 'InwardValue', 'OutwardQuantity', 'OutwardValue', 'ClosingBalance', 'ClosingValue', 'AffectsGrossProfit', 'SortPosition'], lstFilters, args.targetCompany, new Date(args.fromDate), new Date(args.toDate));
        result = renameObjectArrayProperties(result, new Map<string, string>([['Name', 'stock_item_name'], ['Parent', 'stock_group_name'], ['OpeningBalance', 'opening_quantity'], ['OpeningValue', 'opening_value'], ['InwardQuantity', 'inward_quantity'], ['InwardValue', 'inward_value'], ['OutwardQuantity', 'outward_quantity'], ['OutwardValue', 'outward_value'], ['ClosingBalance', 'closing_quantity'], ['ClosingValue', 'closing_value']]));
        let tableID = await cacheTable(new Map<string, string>([['stock_item_name', 'string'], ['stock_group_name', 'string'], ['opening_quantity', 'number'], ['opening_value', 'number'], ['inward_quantity', 'number'], ['inward_value', 'number'], ['outward_quantity', 'number'], ['outward_value', 'number'], ['closing_quantity', 'number'], ['closing_value', 'number']]), result);
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'ledger-balance',
    {
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
    },
    async (args) => {
      try {
        let lstFilters = new Map<string, string>([['Exact_Ledger', `$$IsEqual:$Name:"${args.ledgerName.replace(/"/g, '""')}"`]]);
        let result = await queryCollection('Ledger', ['ClosingBalance'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
        if (result.length > 0) {
          return { content: [{ type: 'text', text: JSON.stringify({ amount: result[0].ClosingBalance }) }] };
        }
        else {
          return { isError: true, content: [{ type: 'text', text: 'No ledger found' }] };
        }
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'stock-item-balance',
    {
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
    },
    async (args) => {
      try {
        let lstFilters = new Map<string, string>([['Exact_StockItem', `$$IsEqual:$Name:"${args.itemName.replace(/"/g, '""')}"`]]);
        let result = await queryCollection('StockItem', ['ClosingBalance', 'Unit'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
        return {
          content: [{ type: 'text', text: JSON.stringify(result.length ? { quantity: result[0].ClosingBalance, unit_of_measurement: result[0].Unit } : '') }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'bills-outstanding',
    {
      title: 'Bills Outstanding',
      description: `fetches pending overdue outstanding bills receivable or payable as on date with fields bill_date,reference_number,outstanding_amount,party_name,overdue_days. outstanding_amount = Debit is negative and Credit is positive. party_name = ledger_name. returns output cached in pglite postgres in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        nature: z.enum(['receivable', 'payable']),
        toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('as on date')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        let lstFilters = new Map<string, string>();
        if (args.nature) {
          lstFilters.set('Nature', `$$IsEqual:($_PrimaryGroup:Group:($Parent:Ledger:$Parent)):"${args.nature === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'}"`);
        }
        let result = await queryCollection('Bill', ['BillDate', 'Name', 'ClosingBalance', 'Parent', '_OverDueDays'], lstFilters, args.targetCompany, undefined, new Date(args.toDate));
        result = renameObjectArrayProperties(result, new Map<string, string>([['BillDate', 'bill_date'], ['Name', 'reference_number'], ['ClosingBalance', 'outstanding_amount'], ['Parent', 'party_name'], ['_OverDueDays', 'overdue_days']]));
        let tableID = await cacheTable(new Map<string, string>([['bill_date', 'date'], ['reference_number', 'string'], ['outstanding_amount', 'number'], ['party_name', 'string'], ['overdue_days', 'number']]), result);
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'ledger-account',
    {
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
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['ledgerName', args.ledgerName]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }

      // verify if ledger exists before making report call to avoid unnecessary processing and load on Tally
      let lstLedger = await queryCollection('Ledger', ['Name'], new Map<string, string>([['Exact_Ledger', `$$IsEqual:$Name:"${args.ledgerName.replace(/"/g, '""')}"`]]), args.targetCompany);
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
    }
  );

  mcpServer.registerTool(
    'stock-item-account',
    {
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
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['itemName', args.itemName]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }

      // verify if stock item exists before making report call to avoid unnecessary processing and load on Tally
      let lstStockItem = await queryCollection('StockItem', ['Name'], new Map<string, string>([['Exact_StockItem', `$$IsEqual:$Name:"${args.itemName.replace(/"/g, '""')}"`]]), args.targetCompany);
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

    }
  );

  mcpServer.registerTool(
    'ledger-create-update',
    {
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
    },
    async (args) => {
      try {
        if (Array.isArray(args.masters) && args.masters.length > 0) {
          let objMasterInput: Map<string, any> = new Map();
          let lstObjMasters: any[] = [];

          // assign books begin from date by calling queryCollection
          let booksBeginFrom = new Date();
          const resultBooksBeginFrom = await queryCollection('Company', ['Name', 'BooksFrom', 'IsActiveCompany'], new Map<string, string>());

          if (resultBooksBeginFrom.length === 0) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'No company found to determine books begin from date' }]
            }
          }

          if (!args.targetCompany) { //choose Active company
            booksBeginFrom = resultBooksBeginFrom.filter((item) => item.IsActiveCompany)[0].BooksFrom;
          } else { //choose specified target company
            booksBeginFrom = resultBooksBeginFrom.filter((item) => item.Name === args.targetCompany)[0].BooksFrom;
          }

          args.masters.forEach((master) => {
            let objLedger: any = {};
            if (master._name) objLedger._name = master._name;
            if (master.name) objLedger.name = master.name;
            if (master.parent) objLedger.parent = master.parent;
            if (master.openingBalance !== undefined) objLedger.openingBalance = master.openingBalance;
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
          }
        } else {
          return {
            isError: true,
            content: [{ type: 'text', text: 'masters array is required with at least one master object to create or update' }]
          }
        }
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }

    }
  );

  mcpServer.registerTool(
    'set-company',
    {
      title: 'Set Company',
      description: `sets the active company context in Tally Prime. This changes the global company context used by Tally for subsequent operations and report queries`,
      inputSchema: {
        companyName: z.string().describe('company name to set as active, validate it using list-master tool with collection as company')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        let inputParams = new Map([['SVCurrentCompany', utility.String.escapeHTML(args.companyName)]]);
        await invokeTallyAction('ChangeCurrentCompany', inputParams);
        return { content: [{ type: 'text', text: JSON.stringify('OK') }] };
      } catch (err) {
        return {
          isError: true, content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }

    }
  );

  mcpServer.registerTool(
    'set-period',
    {
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
    },
    async (args) => {
      try {
        let _fromDate = new Date(args.fromDate);
        let _toDate = new Date(args.toDate);
        let inputParams = new Map([['SVFromDate', utility.Date.format(_fromDate, 'd-MMM-yyyy')], ['SVToDate', utility.Date.format(_toDate, 'd-MMM-yyyy')]]);
        await invokeTallyAction('Change Period', inputParams);
        return { content: [{ type: 'text', text: JSON.stringify('OK') }] };
      } catch (err) {
        return {
          isError: true, content: [{ type: 'text', text: JSON.stringify(err) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'company-info',
    {
      title: 'Company Info',
      description: `returns basic information of the open company/companies in Tally with fields company_name, financial_year_start, financial_year_end, state, country, email. Useful to establish the correct financial year and reporting context before running dated reports. returns JSON array of objects`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. skip for default active company. validate using list-master / metadata with collection Company')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        let raw = await queryCollection('Company', ['Name', 'BooksFrom', 'StateName', 'CountryName', 'Email'], new Map<string, string>(), args.targetCompany);
        let result = raw.map((r: any) => {
          const s = r.BooksFrom;
          let fyStart: string | null = null, fyEnd: string | null = null;
          if (s instanceof Date) {
            fyStart = utility.Date.format(s, 'yyyy-MM-dd');
            const e = new Date(s.getFullYear() + 1, s.getMonth(), s.getDate());
            e.setDate(e.getDate() - 1);
            fyEnd = utility.Date.format(e, 'yyyy-MM-dd');
          }
          return { company_name: r.Name, financial_year_start: fyStart, financial_year_end: fyEnd, state: r.StateName, country: r.CountryName, email: r.Email };
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
      }
    }
  );

  mcpServer.registerTool(
    'day-book',
    {
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
    },
    async (args) => {
      try {
        let inputParams = new Map<string, any>([
          ['fromDate', args.fromDate],
          ['toDate', args.toDate],
          ['voucherType', args.voucherType || '']
        ]);
        if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
        const resp = await fetchReport('day-book', inputParams);
        if (resp.error)
          return { isError: true, content: [{ type: 'text', text: resp.error }] };
        let tableID = await cacheTable(new Map<string, string>([['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['party_ledger', 'string'], ['amount', 'amount'], ['narration', 'string']]), resp.data);
        return { content: [{ type: 'text', text: JSON.stringify({ tableID }) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
      }
    }
  );

  mcpServer.registerTool(
    'voucher-register',
    {
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
    },
    async (args) => {
      try {
        let inputParams = new Map<string, any>([
          ['fromDate', args.fromDate],
          ['toDate', args.toDate],
          ['voucherType', args.voucherType || ''],
          ['voucherNumber', args.voucherNumber || '']
        ]);
        if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
        const resp = await fetchReport('voucher-register', inputParams);
        if (resp.error)
          return { isError: true, content: [{ type: 'text', text: resp.error }] };
        const tableID = await cacheTable(new Map<string, string>([['date', 'date'], ['voucher_type', 'string'], ['voucher_number', 'string'], ['party_ledger', 'string'], ['place_of_supply', 'string'], ['ledger_name', 'string'], ['ledger_group', 'string'], ['amount', 'amount'], ['dr_cr', 'string'], ['narration', 'string']]), resp.data);
        return { content: [{ type: 'text', text: JSON.stringify({ tableID }) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
      }
    }
  );

  mcpServer.registerTool(
    'create-voucher',
    {
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
        dryRun: z.boolean().optional().describe('defaults to true (preview only). set false to actually write to Tally')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        const entries = args.entries as { ledger: string; amount: number; isDebit: boolean }[];
        let dr = 0, cr = 0;
        for (const e of entries) { if (e.isDebit) dr += Math.abs(e.amount); else cr += Math.abs(e.amount); }
        if (Math.abs(dr - cr) > 0.01)
          return { isError: true, content: [{ type: 'text', text: `Voucher is not balanced: total debit ${dr.toFixed(2)} != total credit ${cr.toFixed(2)}. Adjust entries so debits equal credits.` }] };

        const remoteId = args.remoteId || ('mcp-' + crypto.randomUUID());
        const signedEntries = entries.map(e => ({ ledger: e.ledger, isDebit: e.isDebit, amount: ((e.isDebit ? -1 : 1) * Math.abs(e.amount)).toFixed(2) }));
        let objInput = new Map<string, any>([
          ['remoteId', remoteId],
          ['voucherType', args.voucherType],
          ['date', new Date(args.date)],
          ['entries', signedEntries]
        ]);
        if (args.voucherNumber) objInput.set('voucherNumber', args.voucherNumber);
        if (args.partyLedger) objInput.set('partyLedger', args.partyLedger);
        if (args.reference) objInput.set('reference', args.reference);
        if (args.narration) objInput.set('narration', args.narration);
        if (args.targetCompany) objInput.set('targetCompany', args.targetCompany);

        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, message: `Preview only, nothing written. Debit=${dr.toFixed(2)} Credit=${cr.toFixed(2)}. Set dryRun=false to post this ${args.voucherType} voucher. remoteId that will be assigned: ${remoteId}`, remoteId, xml: renderPushTemplate('voucher-create', objInput) }, null, 2) }] };
        }
        const res = await importVouchers('voucher-create', objInput);
        const ok = res.created > 0 && res.errors === 0 && res.exceptions === 0;
        return { isError: !ok, content: [{ type: 'text', text: JSON.stringify({ dryRun: false, success: ok, remoteId, created: res.created, errors: res.errors, exceptions: res.exceptions, lineErrors: res.lineErrors, note: ok ? 'Voucher posted. Store remoteId to delete/amend later.' : 'Posting failed; see lineErrors.' }) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
      }
    }
  );

  mcpServer.registerTool(
    'delete-voucher',
    {
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
    },
    async (args) => {
      try {
        let objInput = new Map<string, any>([
          ['remoteId', args.remoteId],
          ['voucherType', args.voucherType],
          ['date', new Date(args.date)]
        ]);
        if (args.targetCompany) objInput.set('targetCompany', args.targetCompany);
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, message: `Preview only, nothing deleted. Set dryRun=false to delete voucher with remoteId ${args.remoteId}.`, xml: renderPushTemplate('voucher-delete', objInput) }, null, 2) }] };
        }
        const res = await importVouchers('voucher-delete', objInput);
        const ok = res.deleted > 0 && res.errors === 0 && res.exceptions === 0;
        return { isError: !ok, content: [{ type: 'text', text: JSON.stringify({ dryRun: false, success: ok, deleted: res.deleted, errors: res.errors, exceptions: res.exceptions, lineErrors: res.lineErrors, note: ok ? 'Voucher deleted.' : 'Delete failed (voucher may have no REMOTEID or wrong date/type).' }) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(err instanceof Error ? err.message : err) }] };
      }
    }
  );

  return mcpServer;
}