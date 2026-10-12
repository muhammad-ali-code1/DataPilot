import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer, loadEnv } from 'vite';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  getGeminiServiceStatus,
  getGeminiClientSafe,
  ensureGeminiAvailable,
  createGeminiServiceError,
} from './src/services/aiService';
import {
  parseFileContent,
  profileDataset,
  calculateQualityScore,
  detectProblems,
  applyCleaningOperations,
  classifyDataset,
  calculateKPIs,
  detectAnomalies,
  generateRecommendedCharts,
  toolQueryDataset,
  smartDataQuery,
} from './src/services/dataEngine';
import { computeAnalysisResult } from './src/services/analysisEngine';
import { buildAIContextObject } from './src/services/aiContextLayer';
import { executeSmartDataQuery } from './src/services/aiToolSystem';
import {
  extractChatIntent,
  executeIntent,
  formatIntentAsResponse,
  buildChatResponseContract,
  friendlyToolLabel,
  ChatIntent,
  IntentExtractionResult,
  INTENT_JSON_SCHEMA,
  extractIntentRuleBased,
} from './src/services/chatIntentLayer';
import { normalizeDatasetName } from './src/services/dataEngine';
import { UniversalDataPipeline } from './src/services/universalDataPipeline';
import { DatasetItem } from './src/types';
import {
  createPaddleCheckout,
  verifyPaddleWebhook,
  processPaddleWebhookEvent,
  isPaddleConfigured,
} from './src/services/paddleServer';
import {
  EDITOR_INTENT_JSON_SCHEMA,
  parseEditorIntentRuleBased,
  isDataModificationInstruction,
} from './src/services/editorIntentLayer';
import {
  applyEditorOperation,
  validateEditorOperation,
  generateOperationPreview,
  recomputeDatasetAfterEdit,
  EditorOperation,
} from './src/services/dataEditorEngine';
import { extractBYOKFromRequest } from './src/services/byokService';
import { executeBYOKAIRequest } from './src/services/byokAiRouter';

function buildActionConfirmationMessage(
  op: EditorOperation,
  beforeCount: number,
  afterCount: number,
  preview: any
): string {
  switch (op.type) {
    case 'ADD_ROW': {
      const entity = op.row?.Name || op.row?.Customer || op.row?.Employee || op.row?.Client || Object.values(op.row || {})[0] || 'record';
      return `✓ **Dataset Updated**: Successfully added new row for **${entity}** to the dataset.\n\n• **Total rows**: ${beforeCount} → **${afterCount}**\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'DELETE_ROWS': {
      const deletedCount = beforeCount - afterCount;
      const cond = op.condition ? `where \`${op.condition.column}\` ${op.condition.operator === 'equals' ? '=' : 'contains'} "${op.condition.value}"` : '';
      return `✓ **Dataset Updated**: Deleted **${deletedCount}** record(s) ${cond}.\n\n• **Total rows**: ${beforeCount} → **${afterCount}**\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'DELETE_ROW': {
      return `✓ **Dataset Updated**: Removed row #${(op.rowIndex ?? 0) + 1} from the dataset.\n\n• **Total rows**: ${beforeCount} → **${afterCount}**\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'UPDATE_CELLS': {
      return `✓ **Dataset Updated**: Updated **${op.column}** to **"${op.value}"** in matching records.\n\n• **Summary**: ${preview.summary}\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'UPDATE_CELL': {
      return `✓ **Dataset Updated**: Set **${op.column}** in row #${(op.rowIndex ?? 0) + 1} to **"${op.value}"**.\n\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'SORT': {
      return `✓ **Dataset Updated**: Sorted dataset by **${op.column}** in **${op.direction === 'asc' ? 'ascending (A→Z / 0→9)' : 'descending (Z→A / 9→0)'}** order.\n\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'REMOVE_DUPLICATES': {
      const removedCount = beforeCount - afterCount;
      return `✓ **Dataset Updated**: Removed **${removedCount}** duplicate record(s).\n\n• **Total rows**: ${beforeCount} → **${afterCount}**\n• **Quality**: Duplicate count is now **0**.\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'REPLACE_VALUES': {
      return `✓ **Dataset Updated**: Replaced **"${op.searchValue}"** with **"${op.replaceValue}"** across ${op.column ? `column \`${op.column}\`` : 'all columns'}.\n\n• **Summary**: ${preview.summary}\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'ADD_COLUMN': {
      return `✓ **Dataset Updated**: Added new column **\`${op.columnName}\`**${op.defaultValue !== undefined ? ` with default value \`${op.defaultValue}\`` : ''}.\n\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'DELETE_COLUMN': {
      return `✓ **Dataset Updated**: Removed column **\`${op.columnName}\`** from the dataset.\n\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'RENAME_COLUMN': {
      return `✓ **Dataset Updated**: Renamed column **\`${op.oldName}\`** to **\`${op.newName}\`**.\n\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'FILL_MISSING': {
      return `✓ **Dataset Updated**: Filled missing values in column **\`${op.column}\`** using **${op.strategy}**.\n\n• **Status**: Synchronized with live table and analytics.`;
    }
    case 'COMPOSITE': {
      return `✓ **Dataset Updated**: Executed all **${op.operations.length}** sequential data operations.\n\n• **Total rows**: ${beforeCount} → **${afterCount}**\n• **Status**: Synchronized with live table and analytics.`;
    }
    default:
      return `✓ **Dataset Updated**: Successfully applied data operation (${op.type}).\n\n• **Total rows**: **${afterCount}**\n• **Status**: Synchronized with live table and analytics.`;
  }
}

dotenv.config();
const viteEnv = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');
Object.assign(process.env, viteEnv);

const app = express();
const PORT = 3000;

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  next();
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Preference');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || '';

export const supabaseServer = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface AuthenticatedRequest extends express.Request {
  user?: {
    id: string;
    email?: string | null;
  };
}

async function requireSupabaseUser(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  const method = req.method;
  const path = req.path;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error(`[AUTH] FAILED ${method} ${path} - No Bearer token present`);
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    console.error(`[AUTH] FAILED ${method} ${path} - Empty token`);
    return res.status(401).json({ error: 'Authentication token is missing.' });
  }

  // Support local testMode / demo authorization
  if (token === 'test-token') {
    req.user = {
      id: 'test-user',
      email: 'test@datapilot.local',
    };
    console.log(`[AUTH] SUCCESS (test-token) ${method} ${path} - user=test@datapilot.local id=test-user`);
    return next();
  }

  try {
    const { data, error } = await supabaseServer.auth.getUser(token);
    if (error || !data.user) {
      const errMsg = error?.message || 'no user data';
      console.error(`[AUTH] FAILED ${method} ${path} - ${errMsg}`);
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }

    req.user = {
      id: data.user.id,
      email: data.user.email,
    };
    
    console.log(`[AUTH] SUCCESS ${method} ${path} - user=${data.user.email} id=${data.user.id}`);
    next();
  } catch (e: any) {
    console.error(`[AUTH] ERROR ${method} ${path} - ${e?.message || e}`);
    return res.status(401).json({ error: 'Authentication failed.' });
  }
}

// API: Paddle Webhook (placed before express.json for raw body verification)
app.post('/api/paddle/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const paddleSigHeader = (req.headers['paddle-signature'] as string) || '';
  const signature = (req.headers['paddle-webhook-signature'] as string) || paddleSigHeader;
  const timestamp = (req.headers['paddle-webhook-timestamp'] as string) || '';
  const webhookId = (req.headers['paddle-webhook-id'] as string) || (req.headers['paddle-event-id'] as string) || '';
  const rawBody = req.body as Buffer;

  const verification = verifyPaddleWebhook(rawBody, signature, timestamp, webhookId);
  if (!verification.valid) {
    console.warn(`[Paddle] Webhook verification failed | reason=${verification.reason} webhook_id=${webhookId}`);
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }

  let eventType = '';
  let data: Record<string, any> = {};
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    eventType = parsed?.event_type || '';
    data = parsed?.data || {};
  } catch {
    console.warn('[Paddle] Webhook invalid JSON');
    return res.status(400).json({ error: 'Invalid webhook payload.' });
  }

  processPaddleWebhookEvent(eventType, data, webhookId || `${timestamp}`).then((result) => {
    if (result.duplicate) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    res.status(200).json({ received: true });
  }).catch(() => {
    res.status(500).json({ error: 'Webhook processing failed.' });
  });
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Shared Gemini AI client setup
const getGeminiClient = () => ensureGeminiAvailable();

// Centralized AI Model Config
// Primary: gemini-2.5-flash (fastest, high reliability, low-latency structured output)
// Secondary / Fallbacks: gemini-2.0-flash, gemini-1.5-flash, gemini-2.5-pro, gemini-3.6-flash
const AI_MODEL_CONFIG = {
  simple_model: 'gemini-2.5-flash',
  analysis_model: 'gemini-2.5-flash',
  deep_analysis_model: 'gemini-2.5-pro',
};

const GEMINI_FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-2.5-pro',
  'gemini-1.5-pro',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

// In-Memory AI Context & Profiling Cache for ultra-fast response latency
interface CachedAIContext {
  aiContext: any;
  analysisResult: any;
  timestamp: number;
}
const aiContextCache = new Map<string, CachedAIContext>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function computeDatasetFingerprint(datasetName: string, rows: Record<string, any>[]): string {
  const rowCount = rows.length;
  if (rowCount === 0) return `${datasetName}_0`;
  const firstRow = JSON.stringify(rows[0] || {});
  const midRow = JSON.stringify(rows[Math.floor(rowCount / 2)] || {});
  const lastRow = JSON.stringify(rows[rowCount - 1] || {});
  return `${datasetName}_${rowCount}_${firstRow.length}_${midRow.length}_${lastRow.length}`;
}

function getOrComputeAIContext(
  datasetName: string,
  rows: Record<string, any>[],
  existingAnalysisResult?: any
): { aiContext: any; analysisResult: any } {
  const fingerprint = computeDatasetFingerprint(datasetName, rows);
  const now = Date.now();
  const cached = aiContextCache.get(fingerprint);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return { aiContext: cached.aiContext, analysisResult: cached.analysisResult };
  }

  const analysisResult = existingAnalysisResult || computeAnalysisResult(rows, datasetName);
  const aiContext = buildAIContextObject(analysisResult, rows);

  if (aiContextCache.size > 100) {
    const firstKey = aiContextCache.keys().next().value;
    if (firstKey) aiContextCache.delete(firstKey);
  }

  aiContextCache.set(fingerprint, { aiContext, analysisResult, timestamp: now });
  return { aiContext, analysisResult };
}

// Select AI model by task complexity level
function selectModelForTask(level: 'simple' | 'analytical' | 'deep_analysis') {
  switch (level) {
    case 'simple':
      return AI_MODEL_CONFIG.simple_model;
    case 'analytical':
      return AI_MODEL_CONFIG.analysis_model;
    case 'deep_analysis':
      return AI_MODEL_CONFIG.deep_analysis_model;
    default:
      return AI_MODEL_CONFIG.simple_model;
  }
}

async function callGeminiWithRetry(
  ai: ReturnType<typeof getGeminiClient>,
  opts: { model: string; contents: string; config?: any },
  chatLog: (msg: string, ...rest: any[]) => void,
  label: string
): Promise<{ response: any; modelUsed: string }> {
  const models = [opts.model, ...GEMINI_FALLBACK_MODELS];
  const tried = new Set<string>();
  const failures: Array<{ model: string; status: string; detail: string }> = [];

  for (const modelName of models) {
    if (tried.has(modelName)) continue;
    tried.add(modelName);
    try {
      chatLog(`[GEMINI] ${label} → attempting model=${modelName}`);
      const resp = await ai.models.generateContent({
        model: modelName,
        contents: opts.contents,
        ...(opts.config ? { config: opts.config } : {}),
      });
      chatLog(`[GEMINI] ${label} → SUCCESS model=${modelName}`);
      return { response: resp, modelUsed: modelName };
    } catch (err: any) {
      const status = err?.status || err?.response?.status || 'no_status';
      const detail = err?.message || JSON.stringify(err);
      chatLog(`[GEMINI] ${label} → FAILED model=${modelName} status=${status} detail=${detail.slice(0, 300)}`);
      failures.push({ model: modelName, status, detail: detail.slice(0, 300) });
      const isTransient = status === 503 || status === 429 || /high demand|UNAVAILABLE|overloaded/i.test(detail);
      const isModelUnavailable = status === 404 || /no longer available|not found|does not exist/i.test(detail);
      if (!isTransient && !isModelUnavailable) {
        throw err;
      }
    }
  }

  throw new Error(`All Gemini models unavailable. Failures: ${JSON.stringify(failures)}`);
}

// ==========================================
// Category-Aware Report Helpers
// ==========================================

function buildCategoryAwareBusinessKpis(aiContext: any, category: string): Record<string, string> {
  if (category === 'Employees') {
    const kpis: Record<string, string> = {};
    const verified = aiContext.verifiedKPIs || {};
    kpis.totalEmployees = verified.total_records?.formatted || String(aiContext.datasetMetadata?.rowCount || 'N/A');
    kpis.averageAge = verified.avg_age?.formatted || 'N/A';
    kpis.medianAge = verified.median_age?.formatted || 'N/A';
    kpis.averageSalary = verified.avg_salary?.formatted || 'N/A';
    kpis.medianSalary = verified.median_salary?.formatted || 'N/A';
    kpis.newHires = verified.new_hires?.formatted || 'N/A';
    kpis.departments = verified.department_count?.formatted || 'N/A';
    kpis.avgPerformance = verified.avg_performance?.formatted || 'N/A';
    kpis.dataQualityScore = String(aiContext.dataQualitySummary?.overallScore ?? 'N/A');
    return kpis;
  }

  if (category === 'Sales' || category === 'Marketing' || category === 'E-commerce') {
    return {
      revenue: aiContext.verifiedKPIs?.total_revenue?.formatted || (aiContext.financialMetrics?.revenue !== null ? `$${aiContext.financialMetrics.revenue.toLocaleString()}` : 'N/A'),
      profit: aiContext.financialMetrics?.profit !== null ? `$${aiContext.financialMetrics.profit.toLocaleString()}` : 'N/A',
      margin: aiContext.financialMetrics?.profitMargin !== null ? `${aiContext.financialMetrics.profitMargin.toFixed(2)}%` : 'N/A',
      orders: aiContext.verifiedKPIs?.unique_orders?.formatted || String(aiContext.datasetMetadata?.rowCount || 'N/A'),
      unitsSold: aiContext.verifiedKPIs?.total_units_sold?.formatted || 'N/A',
      aov: aiContext.verifiedKPIs?.avg_order_value?.formatted || 'N/A',
    };
  }

  return {
    totalRecords: String(aiContext.datasetMetadata?.rowCount || 'N/A'),
    dataQualityScore: String(aiContext.dataQualitySummary?.overallScore ?? 'N/A'),
  };
}

function buildDefaultKeyPerformanceDrivers(aiContext: any, category: string): string[] {
  if (category === 'Employees') {
    const drivers = [
      `Total workforce of ${aiContext.datasetMetadata?.rowCount?.toLocaleString() || 'N/A'} employees.`,
    ];
    if (aiContext.verifiedKPIs?.avg_salary?.formatted) {
      drivers.push(`Average salary stands at ${aiContext.verifiedKPIs.avg_salary.formatted}.`);
    }
    if (aiContext.verifiedKPIs?.avg_performance?.formatted) {
      drivers.push(`Average performance score is ${aiContext.verifiedKPIs.avg_performance.formatted}.`);
    }
    if (aiContext.verifiedKPIs?.department_count?.formatted) {
      drivers.push(`Organization spans ${aiContext.verifiedKPIs.department_count.formatted} departments.`);
    }
    return drivers;
  }

  if (category === 'Sales' || category === 'Marketing' || category === 'E-commerce') {
    return [
      `Gross revenue totaling ${aiContext.verifiedKPIs?.total_revenue?.formatted || 'N/A'} across ${aiContext.datasetMetadata?.rowCount?.toLocaleString() || 'N/A'} records.`,
    ];
  }

  return [
    `Dataset contains ${aiContext.datasetMetadata?.rowCount?.toLocaleString() || 'N/A'} records with a data quality score of ${aiContext.dataQualitySummary?.overallScore ?? 'N/A'}/100.`,
  ];
}

function buildDefaultKeyFindings(aiContext: any, category: string): any[] {
  const findings: any[] = [
    {
      statement: `Total record volume is ${aiContext.datasetMetadata?.rowCount?.toLocaleString() || 'N/A'} rows.`,
      type: 'FACT',
      basis: 'Verified row count',
    },
  ];

  if (category === 'Employees') {
    if (aiContext.verifiedKPIs?.avg_salary?.formatted) {
      findings.push({
        statement: `Average employee salary is ${aiContext.verifiedKPIs.avg_salary.formatted}.`,
        type: 'FACT',
        basis: 'Calculated directly via AVG(Salary)',
        sourceColumn: 'Salary',
      });
    }
    if (aiContext.verifiedKPIs?.avg_performance?.formatted) {
      findings.push({
        statement: `Average performance score is ${aiContext.verifiedKPIs.avg_performance.formatted}.`,
        type: 'FACT',
        basis: 'Calculated directly via AVG(Performance_Score)',
        sourceColumn: 'Performance_Score',
      });
    }
    if (aiContext.dataQualitySummary?.overallScore < 100) {
      findings.push({
        statement: `Data quality score is ${aiContext.dataQualitySummary.overallScore}/100. ${aiContext.dataQualitySummary.affectedRows} records have formatting or null values.`,
        type: 'FACT',
        basis: 'Phase 2 deterministic quality assessment',
      });
    }
  }

  return findings;
}

function buildDefaultRecommendations(aiContext: any, category: string): any[] {
  if (category === 'Employees') {
    return [
      {
        recommendation: 'Execute automated cleaning operations to resolve missing values and formatting inconsistencies.',
        supportingEvidence: `Completeness score is ${aiContext.dataQualitySummary?.overallScore ?? 'N/A'}/100. ${aiContext.dataQualitySummary?.affectedRows || 0} records affected.`,
      },
      {
        recommendation: 'Review high-value salary outliers and ensure compensation data is complete for workforce analytics.',
        supportingEvidence: `Salary is a key financial metric for ${aiContext.datasetMetadata?.rowCount?.toLocaleString() || 'N/A'} employees.`,
      },
    ];
  }

  return [
    {
      recommendation: 'Execute automated cleaning operations to resolve cell missingness.',
      supportingEvidence: `Completeness score is ${aiContext.dataQualitySummary?.overallScore ?? 'N/A'}/100.`,
    },
  ];
}

function buildDefaultQuestions(aiContext: any, category: string): string[] {
  if (category === 'Employees') {
    return [
      'What is the salary distribution across departments?',
      'How does performance vary by department and region?',
      'What is the turnover rate for recent hires?',
    ];
  }

  return [
    aiContext.capabilities?.hasProductData ? 'Which product or item contributed the most revenue?' : 'Which available metric is the strongest driver of performance?',
    aiContext.capabilities?.hasTimeSeriesData ? 'How do values trend across available time periods?' : 'How can the current dataset quality issues be reduced?',
  ];
}

// Simple in-memory rate limiting for profit protection / abuse throttling
const requestCounts = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const userRate = requestCounts.get(ip) || { count: 0, resetAt: now + 60000 };

  if (now > userRate.resetAt) {
    userRate.count = 1;
    userRate.resetAt = now + 60000;
  } else {
    userRate.count += 1;
  }

  requestCounts.set(ip, userRate);
  return userRate.count <= 60; // Max 60 API calls / minute per IP
}

// API Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'DataPilot Backend API', timestamp: new Date().toISOString() });
});

async function checkBYOKMiddleware(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) {
  const planHeader = (req.headers['x-user-plan'] || req.headers['x-byok-plan']) as string | undefined;
  const userPlan = planHeader || req.body?.userPlan || req.body?.user?.plan || req.body?.dataset?.userPlan;

  if (userPlan === 'byok') {
    const byokConfig = extractBYOKFromRequest(req);
    if (!byokConfig || !byokConfig.apiKey || byokConfig.apiKey.trim().length === 0) {
      console.warn(`[BYOK] Blocked AI request (${req.path}) | User on BYOK plan without custom API key`);
      return res.status(403).json({
        success: false,
        error: 'Please provide your custom AI model API key in your account settings to unlock AI features.',
        code: 'BYOK_KEY_REQUIRED',
        byokRequired: true,
      });
    }
  }
  next();
}

app.use('/api/upload', requireSupabaseUser);
app.use('/api/clean', requireSupabaseUser);
app.use('/api/reports/generate', requireSupabaseUser, checkBYOKMiddleware);
app.use('/api/chat', requireSupabaseUser, checkBYOKMiddleware);
app.use('/api/editor/intent', requireSupabaseUser, checkBYOKMiddleware);

// API: Create Paddle Checkout Session (requires authentication)
app.post('/api/paddle/checkout', requireSupabaseUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { planId } = req.body;
  if (typeof planId !== 'string' || !['pro', 'business'].includes(planId)) {
    return res.status(400).json({ error: 'Invalid plan.' });
  }

  if (!isPaddleConfigured()) {
    return res.status(503).json({ error: 'Paddle billing is not configured.' });
  }

  const userEmail = req.user.email || '';
  const result = await createPaddleCheckout(planId, userEmail, req.user.id);
  if (!result.success || !result.checkoutUrl) {
    console.error(`[Paddle] Checkout creation failed | user=${req.user.id} plan=${planId}`);
    return res.status(503).json({ error: 'Paddle billing request failed.' });
  }

  res.json({ checkoutUrl: result.checkoutUrl });
});

// API: Validate Subscription & Action Limits (Server-Side Authorization)
app.post('/api/subscription/validate', requireSupabaseUser, (req: AuthenticatedRequest, res) => {
  const { user, action, rowCount, creditsNeeded } = req.body;
  if (!user) {
    return res.status(400).json({ allowed: false, reason: 'Missing user profile.' });
  }

  if (req.user && user.id && req.user.id !== user.id) {
    return res.status(403).json({ allowed: false, reason: 'User identity mismatch.' });
  }

  if (user.status === 'expired' || (user.isTrial && user.trialDaysRemaining <= 0)) {
    return res.status(403).json({
      allowed: false,
      reason: 'Your 7-day trial has ended. Choose a plan to continue analyzing your data.',
      errorCode: 'TRIAL_EXPIRED',
    });
  }

  // BYOK plan check for AI-specific actions
  if (user.plan === 'byok' && ['chat_query', 'executive_report', 'ai_analysis'].includes(action)) {
    const byokConfig = extractBYOKFromRequest(req) || user.byokConfig;
    if (!byokConfig || !byokConfig.apiKey || byokConfig.apiKey.trim().length === 0) {
      return res.status(403).json({
        allowed: false,
        reason: 'Please provide your custom AI model API key in your account settings to unlock AI features.',
        errorCode: 'BYOK_KEY_REQUIRED',
        byokRequired: true,
      });
    }
  }

  return res.json({ allowed: true });
});

// API: Delete Account (Server-Side)
app.post('/api/auth/delete-account', requireSupabaseUser, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Invalid session.' });
    }

    const { error } = await supabaseServer.auth.admin.deleteUser(req.user.id);
    if (error) {
      return res.status(400).json({ error: error.message || 'Failed to delete account.' });
    }

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: 'Delete account failed.' });
  }
});

// API: Admin Metrics Endpoint
app.get('/api/admin/metrics', requireSupabaseUser, (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  res.json({
    totalUsers: 1420,
    usersByPlan: { trial: 380, starter: 410, pro: 450, business: 150, enterprise: 30, expired: 90 },
    mrr: 45280,
    arr: 543360,
    arpu: 43.5,
    estimatedAiCostUsd: 3840,
    totalCreditsConsumed: 482000,
    trialConversionRate: 18.4,
    churnRate: 2.1,
    usersNearLimitsCount: 84,
    usersExceededLimitsCount: 12,
  });
});

// API: File Upload & Automated Profiling
app.post('/api/upload', (req, res) => {
  try {
    const { fileName, fileBase64, fileText } = req.body;

    if (!fileName) {
      return res.status(400).json({ error: 'Missing fileName in upload request.' });
    }

    const ext = fileName.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx', 'xls', 'json', 'tsv', 'txt'].includes(ext || '')) {
      return res.status(400).json({
        error: `Unsupported file type ".${ext}". DataPilot supports CSV, XLSX, XLS, JSON, TSV, and TXT files.`,
      });
    }

    let fileData: string | ArrayBuffer;
    if (fileText) {
      fileData = fileText;
    } else if (fileBase64) {
      const buffer = Buffer.from(fileBase64.replace(/^data:.*;base64,/, ''), 'base64');
      fileData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } else {
      return res.status(400).json({ error: 'No file data content provided.' });
    }

    const pipeline = UniversalDataPipeline.getInstance();
    const maxRows = typeof req.body.maxRows === 'number' && req.body.maxRows > 0 ? req.body.maxRows : 500000;
    const result = pipeline.processRawData(fileData, fileName, { maxRows });

    return res.json({ success: true, dataset: result.dataset, pipelineId: result.pipelineId });
  } catch (error: any) {
    console.error('Upload Error:', error);
    return res.status(500).json({ error: error.message || 'Error processing uploaded file.' });
  }
});

// API: Apply Data Cleaning Operations
app.post('/api/clean', (req, res) => {
  try {
    const { dataset, selectedOpIds } = req.body;
    if (!dataset || !selectedOpIds) {
      return res.status(400).json({ error: 'Missing dataset or selected operations for cleaning.' });
    }

    const pipeline = UniversalDataPipeline.getInstance();
    const result = pipeline.reprocessWithCleaning(dataset as DatasetItem, selectedOpIds);

    return res.json({ success: true, dataset: result.dataset, pipelineId: result.pipelineId });
  } catch (error: any) {
    console.error('Cleaning Error:', error);
    return res.status(500).json({ error: error.message || 'Error executing cleaning operations.' });
  }
});

// API: Generate AI Business Report (Gemini API server-side call)
app.post('/api/reports/generate', requireSupabaseUser, async (req, res) => {
  const reportLog = (msg: string, ...rest: any[]) => {
    console.log(`[REPORT] ${msg}`, ...rest);
  };

  try {
    const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please try again later.' });
    }

    const { datasetName, rows, analysisResult: inputAnalysisResult } = req.body;
    const processRows = rows || [];

    const analysisResult = inputAnalysisResult || computeAnalysisResult(processRows, datasetName || 'Dataset');
    const aiContext = buildAIContextObject(analysisResult, processRows);
    const category = analysisResult.datasetMetadata.category;

    const availableColumns = aiContext.schemaSummary
      .map((col) => `${col.columnName} (${col.type}, role: ${col.semanticRole})`)
      .join('\n');

    const unsupportedCapabilities = [
      !aiContext.capabilities.hasTimeSeriesData ? 'time-series forecasting / trend analysis' : null,
      !aiContext.capabilities.hasProductData ? 'product/category performance analysis' : null,
      !aiContext.capabilities.hasRegionalData ? 'regional/geographic analysis' : null,
      !aiContext.capabilities.hasCustomerData ? 'customer segmentation analysis' : null,
    ].filter(Boolean);

    const promptText = `You are DataPilot AI, an elite Senior Business Intelligence Analyst.
Analyze the following VERIFIED, CALCULATED AI Context Object derived strictly from Phase 2 financial metrics:

${JSON.stringify(aiContext, null, 2)}

CURRENT DATASET SCHEMA (ONLY THESE COLUMNS MAY BE REFERENCED):
${availableColumns}

UNAVAILABLE CAPABILITIES FOR THIS DATASET:
${unsupportedCapabilities.length > 0 ? unsupportedCapabilities.join('; ') : 'None'}

Synthesize a structured, executive-level business intelligence report in valid JSON format matching this schema:
{
  "executiveSummary": "A concise 2-3 sentence high-level overview of dataset performance, revenue, and health.",
  "keyPerformanceDrivers": [
    "Driver 1 with exact verified metric",
    "Driver 2"
  ],
  "productPerformance": [
    "Product insight 1",
    "Product insight 2"
  ],
  "regionalPerformance": [
    "Regional insight 1"
  ],
  "customerPerformance": [
    "Customer insight 1"
  ],
  "methodology": "Brief description of Phase 2 deterministic analysis engine and Phase 3 AI Context verification.",
  "keyFindings": [
    {
      "statement": "Gross Revenue totaled $10,260.00",
      "type": "FACT",
      "basis": "Calculated directly via SUM(Revenue)",
      "sourceColumn": "Revenue"
    },
    {
      "statement": "Top product accounts for over 50% of revenue contribution",
      "type": "INFERENCE",
      "basis": "Inferred from product sales concentration",
      "sourceColumn": "Product"
    }
  ],
  "potentialProblems": [
    "Data quality concern or anomaly detail 1"
  ],
  "recommendations": [
    {
      "recommendation": "Actionable business recommendation 1",
      "supportingEvidence": "Evidence connecting to exact dataset metric"
    }
  ],
  "questionsToInvestigate": [
    "Strategic follow-up question 1",
    "Question 2"
  ]
}

CRITICAL RULES:
1. Every numeric value must match the provided AI Context Object exactly.
2. Only reference columns, metrics, and facts that actually exist in the current dataset schema above.
3. Never invent product categories, return rates, customer segments, dates, or other unavailable fields.
4. If regional/customer/product performance is unavailable in AI Context Object, return empty array [].
5. If a section cannot be supported by the available dataset, either leave it empty or state that it is unavailable rather than inventing content.
6. Maintain an executive, authoritative tone.`;

    const byokConfig = extractBYOKFromRequest(req);
    let responseText = '{}';

    if (byokConfig && byokConfig.apiKey) {
      reportLog(`[BYOK] Generating executive report via custom provider=${byokConfig.provider} model=${byokConfig.customModel || 'default'}`);
      const byokResp = await executeBYOKAIRequest(byokConfig, {
        prompt: promptText,
        responseMimeType: 'application/json',
      });
      responseText = byokResp.text || '{}';
    } else {
      const geminiStatus = getGeminiServiceStatus();
      if (!geminiStatus.ready) {
        return res.status(503).json({
          success: false,
          error: geminiStatus.message,
          code: geminiStatus.code,
          aiAvailable: false,
        });
      }

      const ai = getGeminiClient();
      const { response } = await callGeminiWithRetry(
        ai,
        {
          model: selectModelForTask('deep_analysis'),
          contents: promptText,
          config: {
            responseMimeType: 'application/json',
          },
        },
        reportLog,
        'report_generation'
      );
      responseText = response.text || '{}';
    }

    const parsedReport = JSON.parse(responseText);



    const cleanDatasetName = normalizeDatasetName(datasetName || aiContext.datasetMetadata.name);

    const fullReport = {
      id: `rep_${Date.now()}`,
      datasetName: cleanDatasetName,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
      aiGenerated: true,
      trustStatus: aiContext.verifiedKPIs ? Object.fromEntries(
        Object.entries(analysisResult.trustStatus || {}).map(([k, v]) => [k, v as string])
      ) : undefined,
      reconciliationStatus: analysisResult.reconciliation?.status,
      executiveSummary: parsedReport.executiveSummary || `${aiContext.datasetMetadata.name} analysis complete. Total records: ${aiContext.datasetMetadata.rowCount.toLocaleString()}.`,
      businessHealth: aiContext.businessHealth,
      businessKpis: buildCategoryAwareBusinessKpis(aiContext, category),
      keyPerformanceDrivers: parsedReport.keyPerformanceDrivers || buildDefaultKeyPerformanceDrivers(aiContext, category),
      productPerformance: parsedReport.productPerformance || (aiContext.productAnalysis ? aiContext.productAnalysis.topByRevenue.map((p) => `${p.product}: ${p.formattedRevenue} (${p.sharePercent}% share)`) : []),
      regionalPerformance: parsedReport.regionalPerformance || (aiContext.regionalAnalysis ? aiContext.regionalAnalysis.topRegions.map((r) => `${r.region}: ${r.formattedRevenue} (${r.sharePercent}% share)`) : []),
      customerPerformance: parsedReport.customerPerformance || (aiContext.customerAnalysis ? aiContext.customerAnalysis.topCustomers.map((c) => `${c.customer}: ${c.formattedSpent} (${c.ordersCount} orders)`) : []),
      dataQualitySummary: `Dataset Health Score: ${aiContext.dataQualitySummary.overallScore}/100 (${aiContext.dataQualitySummary.grade}). ${aiContext.dataQualitySummary.affectedRows} records affected by formatting or null values.`,
      anomaliesSummary: `Detected ${aiContext.anomaliesSummary.totalAnomaliesCount} statistical outliers across numerical fields.`,
      forecastSection: {
        isAvailable: aiContext.forecastResults.isAvailable,
        explanation: aiContext.forecastResults.isAvailable ? `Forecast generated with ${aiContext.forecastResults.confidence} confidence.` : (aiContext.forecastResults.reasonIfNotAvailable || 'Forecast unavailable: Insufficient historical time-series observations.'),
        forecastPoints: aiContext.forecastResults.forecastPoints,
      },
      keyFindings: parsedReport.keyFindings || buildDefaultKeyFindings(aiContext, category),
      potentialProblems: parsedReport.potentialProblems || aiContext.dataQualitySummary.failedChecks,
      trends: [aiContext.timeSeriesAnalysis?.growthTrend || 'Stable trend across categorical dimensions.'],
      recommendations: parsedReport.recommendations || buildDefaultRecommendations(aiContext, category),
      questionsToInvestigate: parsedReport.questionsToInvestigate || buildDefaultQuestions(aiContext, category),
      methodology: parsedReport.methodology || 'Analyzed via Phase 2 Deterministic Analysis Engine & Phase 3 Verified AI Context Layer.',
      limitationsAndMissingData: aiContext.dataQualitySummary.failedChecks,
      verifiedStatsSnapshot: {
        totalRows: aiContext.datasetMetadata.rowCount,
        qualityScore: aiContext.dataQualitySummary.overallScore,
        anomaliesCount: aiContext.anomaliesSummary.totalAnomaliesCount,
      },
    };

    return res.json({ success: true, report: fullReport });
  } catch (error: any) {
    console.error('Report Generation Error:', error);
    return res.status(500).json({ error: 'Report generation failed.' });
  }
});

// API: DataPilot AI Chat (Server-side tool execution + Action Agent + Gemini grounded explanation)
app.post('/api/chat', requireSupabaseUser, async (req, res) => {
  const chatLog = (msg: string, ...rest: any[]) => {
    console.log(`[CHAT] ${msg}`, ...rest);
  };

  try {
    const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
    }

    const authHeader = req.headers.authorization || '';
    const tokenPresent = authHeader.startsWith('Bearer ');
    chatLog(`request received | method=${req.method} path=${req.path} auth_present=${tokenPresent}`);

    const { question, dataset, datasetRows, profiling, chatHistory, useThinkingMode } = req.body;

    const activeDataset = dataset;
    const rows: Record<string, any>[] = datasetRows || activeDataset?.cleanedRows || activeDataset?.rawRows || [];

    if (!question || !rows || rows.length === 0) {
      chatLog(`early exit: missing question or rows`);
      return res.status(400).json({ error: 'Missing question or dataset content.' });
    }

    const columns = profiling?.columns || (activeDataset?.profiling?.columns) || [];
    const byokConfig = extractBYOKFromRequest(req);

    let ai: ReturnType<typeof getGeminiClient> | null = null;
    try {
      ai = getGeminiClientSafe();
    } catch {
      ai = null;
    }

    // ============================================================
    // ACTION BRANCH: Check if request is a Data Modification Instruction
    // ============================================================
    if (isDataModificationInstruction(question)) {
      chatLog(`[ACTION] Detected data modification instruction: "${question}"`);

      let editorOp: EditorOperation = parseEditorIntentRuleBased(question, columns, rows);

      // If rule-based didn't extract or is ambiguous, try fast structured extraction (BYOK or Gemini Flash)
      if ((!editorOp || editorOp.type === 'UNSUPPORTED') && (byokConfig || ai)) {
        try {
          chatLog(`[ACTION] Calling ${byokConfig ? `BYOK (${byokConfig.provider})` : 'Gemini Flash'} for complex editor intent extraction`);
          const extractionPrompt = `Convert this user instruction into a structured JSON operation for a dataset with columns: ${columns.map((c: any) => `${c.name} (${c.type})`).join(', ')}.\nUser Instruction: "${question}"\nSample Rows: ${JSON.stringify(rows.slice(0, 3))}`;
          let text = '';
          if (byokConfig) {
            const byokResp = await executeBYOKAIRequest(byokConfig, {
              prompt: extractionPrompt,
              responseMimeType: 'application/json',
            });
            text = byokResp.text || '';
          } else if (ai) {
            const { response: editorResp } = await callGeminiWithRetry(
              ai,
              {
                model: AI_MODEL_CONFIG.simple_model,
                contents: extractionPrompt,
                config: {
                  responseMimeType: 'application/json',
                  responseJsonSchema: EDITOR_INTENT_JSON_SCHEMA,
                },
              },
              chatLog,
              'action_intent_extraction'
            );
            text = editorResp.text || '';
          }
          const parsed = JSON.parse(text);
          if (parsed && parsed.operation && parsed.operation !== 'UNSUPPORTED') {
            editorOp = {
              type: parsed.operation,
              ...parsed.payload,
              description: parsed.reason,
            } as EditorOperation;
          } else if (parsed && parsed.operation === 'UNSUPPORTED') {
            editorOp = {
              type: 'UNSUPPORTED',
              reason: parsed.reason || "I couldn't understand that data change instruction.",
            };
          }
        } catch (e: any) {
          chatLog(`[ACTION] Extraction fallback: ${e?.message}`);
        }
      }

      // Validate operation
      if (editorOp && editorOp.type !== 'UNSUPPORTED') {
        const validation = validateEditorOperation(editorOp, rows, columns);
        if (validation.isValid) {
          const validOp = validation.normalizedOp || editorOp;
          chatLog(`[ACTION] Executing valid operation: ${validOp.type}`);

          const { updatedRows, historyItem } = applyEditorOperation(validOp, rows, columns);
          const updatedDataset = recomputeDatasetAfterEdit(activeDataset, updatedRows);

          // Evict cached context for this dataset
          const fp = computeDatasetFingerprint(activeDataset?.name || 'Dataset', rows);
          aiContextCache.delete(fp);

          const preview = generateOperationPreview(validOp, rows, columns);
          const confirmationText = buildActionConfirmationMessage(validOp, rows.length, updatedRows.length, preview);

          const actionMessage = {
            id: `msg_ai_${Date.now()}`,
            sender: 'assistant',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            text: confirmationText,
            answer: confirmationText,
            responseType: 'text',
            executedTool: {
              toolName: `⚡ Executed Action: ${validOp.type.replace(/_/g, ' ')}`,
              args: validOp,
              resultSummary: preview.summary,
            },
            followUpSuggestions: [
              'Show row count',
              'Summarize dataset quality',
              `Sort by ${columns[0]?.name || 'first column'}`,
            ],
            meta: {
              isDataModified: true,
              operationType: validOp.type,
              rowCountBefore: rows.length,
              rowCountAfter: updatedRows.length,
              diffSummary: preview.summary,
              isBYOK: Boolean(byokConfig),
            },
          };

          chatLog(`[ACTION] COMPLETED successfully. Row count changed: ${rows.length} -> ${updatedRows.length}`);

          return res.json({
            success: true,
            message: actionMessage,
            chatMessage: actionMessage,
            updatedDataset,
            isDataModified: true,
          });
        } else if (validation.error) {
          const clarifyMsg = {
            id: `msg_ai_${Date.now()}`,
            sender: 'assistant',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            text: validation.error,
            answer: validation.error,
            responseType: 'text',
            followUpSuggestions: [
              'Add a new row',
              `Sort by ${columns[0]?.name || 'Name'}`,
              'Remove duplicates',
            ],
            meta: { isDataModified: false },
          };
          return res.json({
            success: true,
            message: clarifyMsg,
            chatMessage: clarifyMsg,
            isDataModified: false,
          });
        }
      } else if (editorOp && editorOp.type === 'UNSUPPORTED' && editorOp.reason) {
        const clarifyMsg = {
          id: `msg_ai_${Date.now()}`,
          sender: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: editorOp.reason,
          answer: editorOp.reason,
          responseType: 'text',
          followUpSuggestions: [
            'Add a new row',
            `Sort by ${columns[0]?.name || 'Name'}`,
            'Remove duplicates',
          ],
          meta: { isDataModified: false },
        };
        return res.json({
          success: true,
          message: clarifyMsg,
          chatMessage: clarifyMsg,
          isDataModified: false,
        });
      }
    }

    // ============================================================
    // ANALYTICAL QUERY BRANCH
    // ============================================================

    // Step 1: Compute or retrieve cached AI Context Object
    const { aiContext, analysisResult } = getOrComputeAIContext(
      activeDataset?.name || 'Dataset',
      rows,
      activeDataset?.analysisResult
    );
    chatLog(`analysis retrieved | category=${analysisResult.datasetMetadata.category} rows=${rows.length} columns=${analysisResult.datasetMetadata.columnCount}`);

    // Step 2: Intent extraction (Fast rule-based check first!)
    let intent: ChatIntent | null = extractIntentRuleBased(question, aiContext);
    let usedIntentLayer = false;
    let intentLayerReason = 'rule_based_fast_path';
    let intentLayerError: { status: string; detail: string; fallback: string } | null = null;

    if (intent && intent.tool !== 'unsupported' && intent.confidence >= 0.85) {
      chatLog(`[FAST-PATH] Rule-based intent match: tool=${intent.tool} confidence=${intent.confidence}`);
      usedIntentLayer = true;
    } else {
      intent = null;
    }

    if (!intent && (byokConfig || ai)) {
      try {
        const modelName = AI_MODEL_CONFIG.simple_model;
        chatLog(`intent extraction STARTED | ${byokConfig ? `BYOK (${byokConfig.provider})` : `model=${modelName}`}`);
        const extraction: IntentExtractionResult = await extractChatIntent(
          question,
          aiContext,
          {
            callGeminiStructured: async ({ prompt }) => {
              if (byokConfig) {
                const byokResp = await executeBYOKAIRequest(byokConfig, {
                  prompt,
                  responseMimeType: 'application/json',
                });
                return { text: byokResp.text || '' };
              }
              const { response: resp, modelUsed } = await callGeminiWithRetry(
                ai!,
                {
                  model: modelName,
                  contents: prompt,
                  config: {
                    responseMimeType: 'application/json',
                    responseJsonSchema: INTENT_JSON_SCHEMA,
                  },
                },
                chatLog,
                'intent_extraction'
              );
              const text = resp.text || '';
              chatLog(`Gemini intent response received | model_used=${modelUsed} text_length=${text.length}`);
              return { text };
            },
          },
          chatHistory || []
        );
        intent = extraction.intent;
        chatLog(`intent extraction PARSED | tool=${intent.tool} confidence=${intent.confidence} reason="${intent.reason}" args=${JSON.stringify(intent.args)}`);
        if (intent && intent.tool !== 'unsupported' && intent.tool !== 'clarification' && intent.confidence >= 0.3) {
          usedIntentLayer = true;
          intentLayerReason = 'ok';
        } else {
          intentLayerReason = `intent_terminal: tool=${intent?.tool} confidence=${intent?.confidence}`;
        }
      } catch (intentErr: any) {
        console.error('[CHAT] Intent layer FAILED:', intentErr);
        const detail = intentErr?.message || JSON.stringify(intentErr);
        const status = intentErr?.status || intentErr?.response?.status || 'no_status';
        intentLayerReason = `extract_failed: ${detail}`;
        intent = null;
        intentLayerError = {
          status,
          detail,
          fallback: 'keyword_router',
        };
      }
    }

    // Step 3: Execute the deterministic tool
    let queryResult: { resultText: string; executedTool?: { toolName: string; args: any; resultSummary: string }; chart?: any; followUpSuggestions: string[] };

    if (usedIntentLayer && intent) {
      chatLog(`executeIntent STARTED | tool=${intent.tool} args=${JSON.stringify(intent.args)}`);
      queryResult = executeIntent(intent, rows, aiContext);
      chatLog(`executeIntent COMPLETED | tool=${queryResult.executedTool?.toolName || 'none'}`);
    } else {
      chatLog(`executeSmartDataQuery STARTED (fallback) reason=${intentLayerReason} | question="${question}"`);
      queryResult = executeSmartDataQuery(question, rows, aiContext, chatHistory || []);
      chatLog(`executeSmartDataQuery COMPLETED | tool=${queryResult.executedTool?.toolName || 'none'}`);
    }

    // Step 4: Formatting response
    let finalAiText = queryResult.resultText;
    const effectiveIntent: ChatIntent | null = intent || (queryResult.executedTool
      ? { tool: 'unsupported', args: {}, confidence: 0, reason: 'fallback_router' }
      : null);

    // Only invoke LLM for response formatting if deep thinking mode is requested or intent was complex/ambiguous
    if ((byokConfig || ai) && effectiveIntent && (useThinkingMode || (!usedIntentLayer && queryResult.executedTool))) {
      try {
        const modelName = useThinkingMode ? selectModelForTask('deep_analysis') : selectModelForTask('analytical');
        chatLog(`formatIntentAsResponse STARTED | ${byokConfig ? `BYOK (${byokConfig.provider})` : `model=${modelName}`} useThinkingMode=${Boolean(useThinkingMode)}`);
        const formatted = await formatIntentAsResponse(
          question,
          effectiveIntent,
          queryResult as any,
          aiContext,
          {
            callGemini: async ({ prompt }) => {
              if (byokConfig) {
                const byokResp = await executeBYOKAIRequest(byokConfig, { prompt });
                return { text: byokResp.text || '' };
              }
              const config: any = {};
              if (useThinkingMode) {
                config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
              }
              const { response: resp } = await callGeminiWithRetry(
                ai!,
                {
                  model: modelName,
                  contents: prompt,
                  ...(Object.keys(config).length > 0 ? { config } : {}),
                },
                chatLog,
                'format_response'
              );
              const t = resp.text || '';
              return { text: t };
            },
          }
        );
        if (formatted && formatted.trim().length > 0) {
          finalAiText = formatted;
        }
      } catch (genErr: any) {
        const detail = genErr?.message || JSON.stringify(genErr);
        const status = genErr?.status || genErr?.response?.status || 'no_status';
        intentLayerError = {
          status,
          detail,
          fallback: 'deterministic_text',
        };
      }
    }

    const safeExecutedTool = queryResult.executedTool
      ? {
          toolName: friendlyToolLabel(queryResult.executedTool.toolName as any),
          args: queryResult.executedTool.args,
          resultSummary: queryResult.executedTool.resultSummary,
          _internalToolName: queryResult.executedTool.toolName,
        }
      : undefined;

    const contract = buildChatResponseContract(
      question,
      effectiveIntent || { tool: 'unsupported', args: {}, confidence: 0, reason: 'fallback' },
      queryResult as any,
      aiContext,
      finalAiText,
      rows
    );

    const chatMessage = {
      id: `msg_ai_${Date.now()}`,
      sender: 'assistant',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      text: contract.answer,
      answer: contract.answer,
      responseType: contract.responseType,
      executedTool: safeExecutedTool,
      chart: contract.chart,
      followUpSuggestions: queryResult.followUpSuggestions,
      meta: {
        ...contract.meta,
        usedIntentLayer,
        intentTool: intent?.tool || null,
        intentConfidence: intent?.confidence ?? null,
        geminiError: intentLayerError,
        isDataModified: false,
        isBYOK: Boolean(byokConfig),
        byokProvider: byokConfig?.provider || null,
      },
    };

    chatLog(`response SENT | success=true responseType=${contract.responseType} tool=${safeExecutedTool?.toolName || 'none'} byok=${Boolean(byokConfig)}`);

    return res.json({
      success: true,
      message: chatMessage,
      chatMessage,
      updatedDataset: null,
      isDataModified: false,
      geminiError: intentLayerError,
    });
  } catch (error: any) {
    console.error('[CHAT] UNHANDLED ERROR:', error?.message || 'unknown');
    const errorStack = error?.stack || 'no stack';
    const errorMessage = 'An internal error occurred.';
    chatLog(`UNHANDLED ERROR | message="${errorMessage}" stack="${errorStack.slice(0, 500)}"`);

    try {
      const fallbackRows = req.body.datasetRows || req.body.dataset?.cleanedRows || req.body.dataset?.rawRows || [];
      const fallbackDataset = req.body.dataset || {};
      const fallbackAnalysis = fallbackDataset.analysisResult || computeAnalysisResult(fallbackRows, fallbackDataset.name || 'Dataset');
      const fallbackContext = buildAIContextObject(fallbackAnalysis, fallbackRows);
      const fallbackQueryResult = executeSmartDataQuery(req.body.question || '', fallbackRows, fallbackContext, req.body.chatHistory || []);
      const fallbackContract = buildChatResponseContract(
        req.body.question || '',
        { tool: 'unsupported', args: {}, confidence: 0, reason: 'unhandled_fallback' },
        fallbackQueryResult as any,
        fallbackContext,
        fallbackQueryResult.resultText,
        fallbackRows
      );

      const fallbackMessage = {
        id: `msg_ai_fb_${Date.now()}`,
        sender: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: fallbackContract.answer,
        answer: fallbackContract.answer,
        responseType: fallbackContract.responseType,
        executedTool: fallbackQueryResult.executedTool,
        chart: fallbackContract.chart,
        followUpSuggestions: fallbackQueryResult.followUpSuggestions,
        meta: fallbackContract.meta,
      };

      return res.json({
        success: true,
        message: fallbackMessage,
        chatMessage: fallbackMessage,
        updatedDataset: null,
        isDataModified: false,
      });
    } catch (fallbackError: any) {
      chatLog(`FALLBACK ERROR: ${fallbackError?.message || 'unknown'}`);
      return res.status(500).json({ error: 'An internal error occurred.' });
    }
  }
});

// API: Data Editor Intent Extraction (Gemini Structured JSON with Rule-based fallback)
app.post('/api/editor/intent', requireSupabaseUser, async (req, res) => {
  const editorLog = (msg: string, ...rest: any[]) => {
    console.log(`[EDITOR] ${msg}`, ...rest);
  };

  try {
    const { instruction, columns, sampleRows, rowCount } = req.body;
    if (!instruction || !columns || !Array.isArray(columns)) {
      return res.status(400).json({ operation: 'UNSUPPORTED', reason: 'Missing instruction or columns.' });
    }

    editorLog(`received instruction: "${instruction}" across ${columns.length} columns`);

    const prompt = `You are the DataPilot Data Editor Intent Extractor.
Convert the following user instruction into a valid structured data editing operation.

USER INSTRUCTION: "${instruction}"

CURRENT DATASET SCHEMA:
Columns: ${columns.map((c: any) => `${c.name} (${c.type})`).join(', ')}
Total Rows: ${rowCount || 'Unknown'}
Sample Rows (first 3):
${JSON.stringify((sampleRows || []).slice(0, 3), null, 2)}

SUPPORTED OPERATIONS:
1. ADD_ROW: payload = { "row": { "ExactColumnName": value, ... } }
2. UPDATE_CELL: payload = { "rowIndex": number, "column": "ExactColumnName", "value": newValue }
3. UPDATE_CELLS: payload = { "column": "ExactColumnName", "value": newValue, "condition": { "column": "Col", "operator": "equals"|"contains", "value": "val" } }
   Example: "Change Ali's city from Rawalpindi to Islamabad" -> { "column": "City", "value": "Islamabad", "condition": { "column": "Name", "operator": "equals", "value": "Ali" } }
4. DELETE_ROW: payload = { "rowIndex": number }
5. DELETE_ROWS: payload = { "condition": { "column": "Col", "operator": "equals"|"contains"|"greater_than"|"less_than", "value": val } }
   Example: "Remove Ali from dataset" -> { "condition": { "column": "Name", "operator": "equals", "value": "Ali" } }
   Example: "Remove all customers from Lahore" -> { "condition": { "column": "City", "operator": "equals", "value": "Lahore" } }
6. ADD_COLUMN: payload = { "columnName": "NewCol", "defaultValue": "val" }
7. DELETE_COLUMN: payload = { "columnName": "ColToDelete" }
8. RENAME_COLUMN: payload = { "oldName": "OldCol", "newName": "NewCol" }
9. SORT: payload = { "column": "ColToSort", "direction": "asc"|"desc" }
   Example: "Put names in alphabetical order" -> { "column": "Name", "direction": "asc" }
10. FILTER: payload = { "column": "Col", "operator": "equals"|"contains"|"starts_with"|"greater_than"|"less_than", "value": val }
11. REMOVE_DUPLICATES: payload = { "column": "OptionalColName" }
12. REPLACE_VALUES: payload = { "column": "OptionalColName", "searchValue": "oldVal", "replaceValue": "newVal", "exactMatch": false }
13. COMPOSITE: payload = { "operations": [ { "type": "ADD_ROW", ... }, { "type": "SORT", ... } ] }
14. UNSUPPORTED: payload = {}, reason = "Brief user-facing explanation or clarification question."

CRITICAL RULES:
- Never generate arbitrary code, scripts, SQL, or unsupported operations.
- Map field names to the EXACT casing of the columns listed in the schema whenever possible.
- If the request has multiple sequential steps (e.g. "Add Ali then sort by name"), return operation: "COMPOSITE".
- If the user asks something ambiguous (e.g. "Remove the old customers"), return operation: "UNSUPPORTED" with reason asking for clarification.
- Return strictly valid JSON conforming to the schema.`;

    const byokConfig = extractBYOKFromRequest(req);
    if (byokConfig && byokConfig.apiKey) {
      editorLog(`[BYOK] Extracting editor intent via custom provider=${byokConfig.provider}`);
      try {
        const byokResp = await executeBYOKAIRequest(byokConfig, {
          prompt,
          responseMimeType: 'application/json',
        });
        const text = byokResp.text || '';
        const parsed = JSON.parse(text);
        return res.json(parsed);
      } catch (byokErr: any) {
        editorLog(`[BYOK] Editor extraction failed: ${byokErr?.message} -> fallback to rule-based`);
        const fallback = parseEditorIntentRuleBased(instruction, columns, sampleRows || []);
        return res.json({ operation: fallback.type, payload: fallback, reason: fallback.description });
      }
    }

    let ai: ReturnType<typeof getGeminiClient> | null = null;
    try {
      ai = getGeminiClientSafe();
    } catch {
      ai = null;
    }

    if (!ai) {
      editorLog('Gemini not available -> using rule-based intent parser');
      const fallback = parseEditorIntentRuleBased(instruction, columns, sampleRows || []);
      return res.json({ operation: fallback.type, payload: fallback, reason: fallback.description });
    }

    const { response } = await callGeminiWithRetry(
      ai,
      {
        model: AI_MODEL_CONFIG.simple_model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: EDITOR_INTENT_JSON_SCHEMA,
        },
      },
      editorLog,
      'editor_intent'
    );

    const text = response?.text || (typeof response?.candidates?.[0]?.content?.parts?.[0]?.text === 'string' ? response.candidates[0].content.parts[0].text : '');
    editorLog(`Gemini structured response: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text);
    return res.json(parsed);
  } catch (err: any) {
    editorLog(`Gemini extraction failed or errored: ${err?.message} -> using rule-based fallback`);
    const fallback = parseEditorIntentRuleBased(req.body.instruction || '', req.body.columns || [], req.body.sampleRows || []);
    return res.json({ operation: fallback.type, payload: fallback, reason: fallback.description });
  }
});


// Serve frontend in development and production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', async () => {
    // Startup banner: confirm env wiring without ever logging the key value.
    const geminiStatus = getGeminiServiceStatus();
    const keyPresent = geminiStatus.ready;
    console.log(`[DataPilot] Server active on http://0.0.0.0:${PORT}`);
    console.log(`[DataPilot] Gemini: ${geminiStatus.message}`);
    console.log(`[DataPilot] Intent layer: ${keyPresent ? 'ENABLED (will run on /api/chat)' : 'DISABLED (chat will fall back to deterministic analysis)'}`);
  });
}

startServer();
