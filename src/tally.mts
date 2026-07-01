import http from 'node:http';
import nunjucks from 'nunjucks';
import { XMLParser } from 'fast-xml-parser';
import * as m from './models.mjs';
import { utility } from './utility.mjs';
import { lstCollectionFields, lstPushXml, lstReportConfig, lstReportXml, xmlInvokeAction, xmlQueryCollection } from './definition.mjs';

const tally_port = parseInt(process.env.TALLY_PORT || '9000'); // default to 9000 XML port of Tally
const lstPullReport: m.ModelPullReportInfo[] = lstReportConfig;

const nEnv = new nunjucks.Environment();
nEnv.addFilter('formatDate', (dt: Date, format: string) => {
    return utility.Date.format(dt, format);
});

export function renameObjectArrayProperties(source: any[], keyMap: Map<string, string>): any[] {
    if (!Array.isArray(source) || source.length == 0)
        return [];

    if (!(keyMap instanceof Map) || keyMap.size == 0)
        return source.map(item => item);

    return source.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return item;

        let renamed: any = {};
        for (const [key, value] of Object.entries(item)) {
            let targetKey = keyMap.get(key) || key;
            Object.defineProperty(renamed, targetKey, { enumerable: true, value });
        }
        return renamed;
    });
}

export async function fetchReport(targetReport: string, inputParams: Map<string, any>): Promise<m.ModelPullResponse> {
    let retval: m.ModelPullResponse = {
        data: undefined
    };

    try {
        let objReport = lstPullReport.find(p => p.name == targetReport);

        if (objReport) {

            let lstInputs = new Map<string, any>();

            //set target company
            let targetCompany = '##SVCurrentCompany'; //default value
            if (inputParams.has('targetCompany') && typeof inputParams.get('targetCompany') == 'string')
                targetCompany = inputParams.get('targetCompany'); //extract from request object

            lstInputs.set('targetCompany', targetCompany); //add targetCompany as one of the params

            //populate input parameters value
            for (let i = 0; i < objReport.input.length; i++) {
                let iName = objReport.input[i].name;
                let iType = objReport.input[i].datatype;

                let _value = inputParams.get(iName);

                //check if validation is required
                if (objReport.input[i].validation_regex) {
                    let strValidationRegex = objReport.input[i].validation_regex || '';
                    let regPtrn = new RegExp(strValidationRegex, 'i');
                    if (typeof _value == 'string' && !regPtrn.test(_value)) {
                        retval.error = objReport.input[i].validation_message || `Invalid value for parameter ${iName}`;
                        return retval;
                    }
                }

                //parse the value based on type
                if (typeof _value == 'number' && iType == 'number')
                    lstInputs.set(iName, _value);
                else if (typeof _value == 'boolean' && iType == 'boolean')
                    lstInputs.set(iName, _value);
                else if (typeof _value == 'string' && iType == 'date' && /^\d\d-\d\d-\d\d\d\d$/.test(_value)) //Date in DD-MM-YYYY
                    lstInputs.set(iName, utility.Date.parse(_value, 'dd-MM-yyyy'));
                else if (typeof _value == 'string' && iType == 'date' && /^\d\d\d\d-\d\d-\d\d/.test(_value)) //ISO DateTime YYYY-MM-DDTHH:MM:SS
                    lstInputs.set(iName, utility.Date.parse(_value.substring(0, 10), 'yyyy-MM-dd'));
                else if (typeof _value == 'string' && iType == 'string')
                    lstInputs.set(iName, _value);
                else {
                    retval.error = `Parameter ${iName} not found or contains invalid value [${_value}]`;
                    return retval;
                }
            }
            retval = await extractReport(objReport, lstInputs);
        }
        else
            retval.error = 'Invalid report';

    } catch (err) {
        retval.error = 'Server exception';
    } finally {
        return retval;
    }

}

export async function queryCollection(targetCollection: string, lstFields: string[], lstFilters: Map<string, string>, targetCompany?: string, fromDate?: Date, toDate?: Date): Promise<any[]> {
    let retval: any[] = [];
    try {
        let objTemplateArgs = new Map<string, any>();

        //assign static variables
        if (targetCompany)
            objTemplateArgs.set('targetCompany', targetCompany);
        if (fromDate)
            objTemplateArgs.set('fromDate', fromDate);
        if (toDate)
            objTemplateArgs.set('toDate', toDate);

        objTemplateArgs.set('collection', targetCollection);

        let objCollection: m.TallyCollectionDefinition = lstCollectionFields.filter(c => c.collection == targetCollection)[0]; //load collection definition
        let lstQueryFields = objCollection.fields.filter(f => lstFields.includes(f.name)); //filter fields based on user query
        objTemplateArgs.set('fields', lstQueryFields); //filter fields queried by user

        if (lstFilters && lstFilters.size > 0) {
            let objFilters: m.TallyFilterDefinition[] = [];
            for (const [k, v] of lstFilters.entries()) {
                objFilters.push({
                    name: k,
                    expression: v
                });
            }
            objTemplateArgs.set('filters', objFilters); //add filters to template arguments
        }

        let respContent = await sendTallyXml(xmlQueryCollection, objTemplateArgs); //send XML to Tally and get response

        let xmlParser = new XMLParser({
            parseTagValue: false,
            isArray(tagName) {
                return (tagName == 'ROW' || tagName.endsWith('.LIST'))
            },
        });
        let resultObj = xmlParser.parse(respContent);
        if (resultObj['DATA'] && Array.isArray(resultObj['DATA']['ROW'])) {
            for (const rowObj of resultObj['DATA']['ROW']) {
                let o: any = new Object();
                for (const field of lstQueryFields) {
                    let _value = rowObj[field.name.toUpperCase()].toString();
                    let value: number | string | boolean | Date | null | undefined = undefined;
                    if (field.datatype == 'boolean')
                        // the generic collection template emits booleans as 1/0, but some report
                        // paths emit Yes/No / true — accept all truthy encodings
                        value = _value == '1' || _value == 'Yes' || _value == 'True' || _value == 'true';
                    else if (field.datatype == 'number' || field.datatype == 'amount' || field.datatype == 'quantity' || field.datatype == 'rate')
                        value = parseFloat(_value);
                    else if (field.datatype == 'date')
                        value = utility.Date.parse(_value, 'yyyy-MM-dd');
                    else
                        // strip Tally control-char noise (&#4; entities + raw control chars) so the
                        // value is safe for JSON / downstream systems like Zoho
                        value = utility.String.unescapeHTML(_value).replace(/&#\d+;/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

                    Object.defineProperty(o, field.name, { enumerable: true, value });
                }
                retval.push(o);
            }
        }
        return retval;
    } catch (err) {
        throw err;
    }

};

export async function invokeTallyAction(targetAction: string, lstParameters: Map<string, any>): Promise<void> {
    try {
        let objTemplateArgs = new Map<string, any>();

        objTemplateArgs.set('targetReport', targetAction);

        let variables: { name: string, value: any }[] = [];
        lstParameters.forEach((v, k) => {
            variables.push({ name: k, value: v });
        });
        objTemplateArgs.set('variables', variables);

        await sendTallyXml(xmlInvokeAction, objTemplateArgs); //send XML to Tally
    } catch (err) {
        throw err;
    }

}

export async function importMasters(targetMaster: string, objMasterInput: Map<string, any>): Promise<m.CreateUpdateDeleteStatus> {
    try {
        let xmlTemplate = lstPushXml.get(targetMaster) || '';
        let respContent = await sendTallyXml(xmlTemplate, objMasterInput); //send XML to Tally and get response
        const xmlParser = new XMLParser();
        let resultObj = xmlParser.parse(respContent);
        let retval: m.CreateUpdateDeleteStatus = resultObj['RESPONSE'];
        return retval;
    } catch (err) {
        throw err;
    }
}

export interface VoucherImportStatus {
    created: number;
    altered: number;
    deleted: number;
    ignored: number;
    errors: number;
    exceptions: number;
    lineErrors: string[];
    raw: string;
}

/* Voucher create / delete use the Import + TYPE Data + ID Vouchers envelope which returns an
 * <IMPORTRESULT> block (unlike master import which returns <RESPONSE>). Parse it here. */
export async function importVouchers(templateKey: string, objInput: Map<string, any>): Promise<VoucherImportStatus> {
    const status: VoucherImportStatus = {
        created: 0, altered: 0, deleted: 0, ignored: 0, errors: 0, exceptions: 0, lineErrors: [], raw: ''
    };
    try {
        const xmlTemplate = lstPushXml.get(templateKey) || '';
        if (!xmlTemplate) {
            status.errors = 1;
            status.lineErrors.push(`Unknown push template: ${templateKey}`);
            return status;
        }
        const raw = await sendTallyXml(xmlTemplate, objInput);
        status.raw = raw;

        if (!raw) {
            status.errors = 1;
            status.lineErrors.push('Empty response from Tally');
            return status;
        }
        // A bare <RESPONSE>...</RESPONSE> here indicates a rejected request (e.g. "Unknown Request")
        const respOnly = raw.match(/^\s*<RESPONSE>([\s\S]*?)<\/RESPONSE>\s*$/);
        if (respOnly) {
            status.exceptions = 1;
            status.lineErrors.push(utility.String.unescapeHTML(respOnly[1].trim()));
            return status;
        }
        if (raw.startsWith('<EXCEPTION>')) {
            status.exceptions = 1;
            const em = raw.match(/<EXCEPTION>(.+?)<\/EXCEPTION>/);
            status.lineErrors.push(em ? em[1].trim() : 'Tally exception');
            return status;
        }

        const numOf = (tag: string): number => {
            const mm = raw.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, 'i'));
            return mm ? parseInt(mm[1], 10) : 0;
        };
        status.created = numOf('CREATED');
        status.altered = numOf('ALTERED');
        status.deleted = numOf('DELETED');
        status.ignored = numOf('IGNORED');
        status.errors = numOf('ERRORS');
        status.exceptions = numOf('EXCEPTIONS');

        const leMatches = raw.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi);
        if (leMatches) {
            for (const le of leMatches) {
                const txt = le.replace(/<\/?LINEERROR>/gi, '').trim();
                if (txt) status.lineErrors.push(utility.String.unescapeHTML(txt));
            }
        }
        return status;
    } catch (err) {
        status.errors = 1;
        status.lineErrors.push(err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Voucher import failed'));
        return status;
    }
}

export interface NestedWalkField {
    key: string;                                   // output property name
    set: string;                                   // raw TDL SET expression (evaluated at the innermost scope)
    datatype: 'string' | 'amount' | 'number' | 'date';
}

/*
 * Fetches a nested Tally collection by walking a dotted object path (e.g.
 * "Voucher.AllLedgerEntries.BillAllocations") and FLATTENING every leaf into one row.
 *
 * This uses the battle-tested tally-database-loader pattern: TYPE=Data with
 * SVEXPORTFORMAT "XML (Data Interchange)", one <PART>/<LINE> per path level with an
 * <EXPLODE> chain, blank intermediate lines and F01.. tagged leaf fields, parsed back with
 * the loader's tab-manipulation. It does NOT crash Tally the way a hand-rolled
 * <XMLTAG>ROW</XMLTAG> double-EXPLODE report does.
 *
 * routePath  : dotted path; first segment is the base collection TYPE.
 * fields     : leaf fields (order preserved; the FIRST field must never be empty — use Guid).
 * filters    : raw TDL formula strings applied to the base collection (already XML-escaped).
 * fetchList  : intermediate collections to FETCH on the base collection.
 */
export async function fetchNestedWalk(
    routePath: string,
    fields: NestedWalkField[],
    filters: string[],
    fetchList: string[],
    statics: { fromDate?: Date; toDate?: Date; targetCompany?: string }
): Promise<any[]> {
    const segments = routePath.split('.').map(s => s.trim()).filter(Boolean);
    const baseCollection = segments[0];
    const routes = ['MyCollection', ...segments.slice(1)]; // repeat sources per level

    const pad2 = (n: number) => String(n).padStart(2, '0');

    // PART per level (each repeats over its route source and explodes into the next)
    let partsXml = '';
    for (let i = 0; i < routes.length; i++)
        partsXml += `<PART NAME="MyPart${pad2(i + 1)}"><LINES>MyLine${pad2(i + 1)}</LINES><REPEAT>MyLine${pad2(i + 1)} : ${routes[i]}</REPEAT><SCROLLED>Vertical</SCROLLED></PART>`;

    // intermediate LINEs carry a blank field and explode into the next PART
    let linesXml = '';
    for (let i = 0; i < routes.length - 1; i++)
        linesXml += `<LINE NAME="MyLine${pad2(i + 1)}"><FIELDS>FldBlank</FIELDS><EXPLODE>MyPart${pad2(i + 2)}</EXPLODE></LINE>`;

    // leaf LINE carries the actual tagged fields
    const leafTags = fields.map((_, i) => `F${pad2(i + 1)}`).join(',');
    linesXml += `<LINE NAME="MyLine${pad2(routes.length)}"><FIELDS>${leafTags}</FIELDS></LINE>`;

    let fieldsXml = '';
    fields.forEach((f, i) => {
        fieldsXml += `<FIELD NAME="F${pad2(i + 1)}"><SET>${f.set}</SET><XMLTAG>F${pad2(i + 1)}</XMLTAG></FIELD>`;
    });
    fieldsXml += `<FIELD NAME="FldBlank"><SET>""</SET></FIELD>`;

    let filterRefsXml = '', filterDefsXml = '';
    if (filters.length) {
        filterRefsXml = `<FILTER>${filters.map((_, j) => `Fltr${pad2(j + 1)}`).join(',')}</FILTER>`;
        filterDefsXml = filters.map((expr, j) => `<SYSTEM TYPE="Formulae" NAME="Fltr${pad2(j + 1)}">${expr}</SYSTEM>`).join('');
    }
    const fetchXml = fetchList.length ? `<FETCH>${fetchList.join(',')}</FETCH>` : '';

    let staticsXml = '<SVEXPORTFORMAT>XML (Data Interchange)</SVEXPORTFORMAT>';
    if (statics.fromDate) staticsXml += `<SVFROMDATE>${utility.Date.format(statics.fromDate, 'd-MMM-yyyy')}</SVFROMDATE>`;
    if (statics.toDate) staticsXml += `<SVTODATE>${utility.Date.format(statics.toDate, 'd-MMM-yyyy')}</SVTODATE>`;
    if (statics.targetCompany && statics.targetCompany !== '##SVCurrentCompany')
        staticsXml += `<SVCURRENTCOMPANY>${utility.String.escapeHTML(statics.targetCompany)}</SVCURRENTCOMPANY>`;

    const xml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TallyMcpNestedWalk</ID></HEADER><BODY><DESC><STATICVARIABLES>${staticsXml}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="TallyMcpNestedWalk"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS></FORM>${partsXml}${linesXml}${fieldsXml}<COLLECTION NAME="MyCollection"><TYPE>${baseCollection}</TYPE>${fetchXml}${filterRefsXml}</COLLECTION>${filterDefsXml}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

    const raw = await postTallyXML(xml);
    if (!raw)
        throw new Error('Empty response from Tally (nested walk)');
    if (raw.startsWith('<EXCEPTION>')) {
        const em = raw.match(/<EXCEPTION>(.+?)<\/EXCEPTION>/);
        throw new Error(em ? em[1].trim() : 'Tally exception');
    }
    if (/<RESPONSE>|Unknown Request/i.test(raw) && !raw.includes('<F01>'))
        throw new Error('Tally rejected the nested-walk request: ' + raw.replace(/\s+/g, ' ').slice(0, 200));

    // loader-style tab manipulation: collapse to tab-separated rows, one per leaf
    let t = raw
        .replace('<ENVELOPE>', '').replace('</ENVELOPE>', '')
        .replace(/<FLDBLANK><\/FLDBLANK>/g, '')
        .replace(/\s+\r\n/g, '')
        .replace(/\r\n/g, '')
        .replace(/\t/g, ' ')
        .replace(/\s+<F/g, '<F')
        .replace(/<\/F\d+>/g, '')
        .replace(/<F01>/g, '\r\n')
        .replace(/<F\d+>/g, '\t')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&tab;/g, '').replace(/&#\d+;/g, '');

    const rows: any[] = [];
    for (const line of t.split(/\r\n/)) {
        if (!line.trim()) continue;
        const cells = line.split('\t');
        const o: any = {};
        fields.forEach((f, i) => {
            const raw = (cells[i] ?? '').trim();
            let value: any;
            if (f.datatype === 'amount' || f.datatype === 'number')
                value = raw === '' || isNaN(parseFloat(raw)) ? 0 : parseFloat(raw);
            else if (f.datatype === 'date')
                value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? utility.Date.parse(raw, 'yyyy-MM-dd') : null;
            else
                value = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            Object.defineProperty(o, f.key, { enumerable: true, value });
        });
        rows.push(o);
    }
    return rows;
}

/* Renders a push template to its final XML WITHOUT posting to Tally — used for write dry-runs. */
export function renderPushTemplate(templateKey: string, objInput: Map<string, any>): string {
    const xmlTemplate = lstPushXml.get(templateKey) || '';
    if (!xmlTemplate)
        return `<!-- unknown push template: ${templateKey} -->`;
    let o: any = {};
    objInput.forEach((v, k) => { o[k] = v; });
    return nEnv.renderString(xmlTemplate, o);
}

async function sendTallyXml(xml: string, lstVariables: Map<string, any>): Promise<string> {
    try {

        // remove targetCompany from lstVariables if found with default value
        if (lstVariables.has('targetCompany') && lstVariables.get('targetCompany') == '##SVCurrentCompany') {
            lstVariables.delete('targetCompany');
        }

        let o = new Object();

        // define properties for every keys in Map in object
        lstVariables.forEach((v, k) => {
            Object.defineProperty(o, k, { enumerable: true, value: v });
        });

        let xmlRequest = nEnv.renderString(xml, o);
        let xmlResponse = await postTallyXML(xmlRequest);
        return xmlResponse;
    } catch (err) {
        throw err;
    }
}

async function postTallyXML(xml: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        try {

            let req = http.request({
                hostname: 'localhost',
                port: tally_port,
                path: '',
                method: 'POST',
                headers: {
                    'Content-Length': Buffer.byteLength(xml, 'utf16le'),
                    'Content-Type': 'text/xml;charset=utf-16'
                }
            },
                (res) => {
                    let data = '';
                    res
                        .setEncoding('utf16le')
                        .on('data', (chunk) => {
                            let result = chunk.toString() || '';
                            data += result;
                        })
                        .on('end', () => {
                            resolve(data);
                        })
                        .on('error', (httpErr) => {
                            reject(httpErr);
                        });
                });
            req.on('error', (reqError: NodeJS.ErrnoException) => {
                let errorType = reqError['message'] || reqError['code'];
                if (errorType === 'ECONNREFUSED')
                    reject('Unable to connect to Tally. Ensure Tally is running and XML server is enabled on port ' + tally_port + ' by going to Help (F1) > Settings > Connectivity in Tally and setting Client / Server configuration, set Tally Prime is action as Server');
                else
                    reject(reqError);
            });
            req.write(xml, 'utf16le');
            req.end();
        }
        catch (err) {
            reject(err);
        }
    });
}

function extractReport(reportConfig: m.ModelPullReportInfo, reportInputParams: Map<string, any>): Promise<m.ModelPullResponse> {
    return new Promise<m.ModelPullResponse>(async (resolve, reject) => {
        let retval: m.ModelPullResponse = {
            data: undefined
        };
        try {

            let parseString = (iStr: string): string => {
                iStr = utility.String.unescapeHTML(iStr);
                iStr = iStr.replace(/&#\d+;/g, ''); //remove unreadable characters;
                return iStr;
            }

            let parseDate = (iDate: string): Date | null => {
                if (/^\d\d\d\d-\d\d-\d\d$/.test(iDate))
                    return utility.Date.parse(iDate, 'yyyy-MM-dd');
                else if (/^\d?\d-\w\w\w-\d\d\d\d$/.test(iDate))
                    return utility.Date.parse(iDate, 'd-MMM-yyyy');
                else if (/^\d?\d-\w\w\w-\d\d$/.test(iDate)) {
                    return utility.Date.parse(iDate, 'd-MMM-yy');
                }
                else
                    return null
            }

            const parseQuantity = (iStr: string): number => {
                let regPatOutput = /^(-?\d+\.\d+|-?\d+)\s.+/g.exec(iStr);
                if (regPatOutput && typeof regPatOutput[1] == 'string' && !isNaN(parseFloat(regPatOutput[1])))
                    return parseFloat(regPatOutput[1]);
                else
                    return 0;
            }

            const parseNumber = (iNum: string) => {
                if (!iNum)
                    return 0;
                else
                    return parseFloat(iNum.replace(/[\(\),]+/g, ''));
            }

            const processRows = (targetObjRows: any[], targetConfigFields: m.ModelPullReportOutputFieldInfo[]): any[] => {
                let data: any[] = [];
                let rowCount = targetObjRows.length;

                //loop through rows
                for (let r = 0; r < rowCount; r++) {
                    let o: any = new Object();

                    //loop through each field and extract value
                    for (const prop of targetConfigFields) {
                        let tagName = prop.name.toUpperCase();
                        let datatype = prop.datatype;
                        let fieldName = prop.name;

                        let value: any = undefined;
                        let _value = targetObjRows[r][tagName];
                        if (_value !== undefined) {
                            if (datatype == 'number')
                                value = parseNumber(_value);
                            else if (datatype == 'date')
                                value = parseDate(_value);
                            else if (datatype == 'boolean')
                                value = _value == '1';
                            else if (datatype == 'quantity')
                                value = parseQuantity(_value);
                            else
                                value = parseString(_value);
                        }

                        Object.defineProperty(o, fieldName, { enumerable: true, value });
                    }

                    //add row to array
                    data.push(o);
                }

                return data;
            }

            let tmplXML = lstReportXml.get(reportConfig.name) || '';
            let respContent = await sendTallyXml(tmplXML, reportInputParams);

            if (!respContent) {
                retval.error = 'Empty data received from Tally';
                return;
            }
            else if (respContent.startsWith('<EXCEPTION>')) {
                let regErr = respContent.match(/<EXCEPTION>(.+)<\/EXCEPTION>/g);
                let errorMessage = 'Unknown error';
                if (regErr && regErr[0])
                    errorMessage = regErr[0].substring(11, regErr[0].length - 12);

                retval.error = errorMessage;
                return;
            }

            let xmlParser = new XMLParser({
                parseTagValue: false,
                isArray(tagName) {
                    return (tagName == 'ROW' || tagName.endsWith('.LIST'))
                },
            });
            let resultObj = xmlParser.parse(respContent);

            let data: any[] = processRows(resultObj['DATA']['ROW'], reportConfig.output);
            retval.data = data;

        } catch (err) {
            throw err;
        } finally {
            resolve(retval);
        }
    });
}
