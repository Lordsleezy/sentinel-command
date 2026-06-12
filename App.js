import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as Speech from 'expo-speech';

const DASHBOARD_API_DEFAULT = 'https://dashboard.sentinelprime.org/api';
const SCOUT_URL = 'https://scout.sentinelprime.org';
const LISTER_URL = 'https://lister.sentinelprime.org';
const INVEST_URL = 'https://invest.sentinelprime.org';
const LEGION_HEALTH_DEFAULT = 'http://192.168.0.117:8001/health';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const AUTH_TOKEN_KEY = 'sentinel_command_session_token';
const ANTHROPIC_KEY = 'sentinel_command_anthropic_key';
const SETTINGS_KEY = 'sentinel_command_settings';
const SHARED_PROMPT_KEY = 'sentinel_command_shared_prompt';

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'invest', label: 'Invest' },
  { id: 'agents', label: 'Agents' },
  { id: 'claude', label: 'Claude' },
  { id: 'settings', label: 'Settings' },
];

const SYSTEM_PROMPT =
  "You are Claude, Paul's AI assistant for Sentinel Prime. Paul is a solo founder building an AI and security software ecosystem. Help him brainstorm, debug, write agent prompts, and make business decisions. Be direct and concise.";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

const fallbackSignals = [
  {
    id: 'NVDA-20260611',
    ticker: 'NVDA',
    direction: 'LONG',
    confidence: 86,
    entry: 142.4,
    target: 154,
    stop: 136.2,
    technicals: { rsi: 61, macd: 'Bullish crossover', volume: '+22% vs 20D' },
    bullCase: ['AI infrastructure demand remains durable', 'Momentum reclaimed the 20-day average'],
    bearCase: ['Valuation leaves little margin for misses', 'Semis remain sensitive to export headlines'],
  },
  {
    id: 'AAPL-20260611',
    ticker: 'AAPL',
    direction: 'PASS',
    confidence: 62,
    entry: 203.1,
    target: 209,
    stop: 198.4,
    technicals: { rsi: 49, macd: 'Neutral', volume: 'Flat' },
    bullCase: ['Services growth supports margins'],
    bearCase: ['No clean momentum confirmation yet'],
  },
];

const fallbackActivity = [
  { id: 'act-1', service: 'Invest', message: 'Signal scan completed', time: new Date().toISOString() },
  { id: 'act-2', service: 'Legion', message: 'Health check queued', time: new Date().toISOString() },
];

const fallbackAgents = [
  { id: 'agent-1', name: 'Codex', repo: 'sentinel-command', status: 'idle', startedAt: new Date().toISOString() },
];

function compactTime(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function money(value) {
  if (value === undefined || value === null || value === '') return '-';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function pct(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return '-';
  return `${Math.round(num)}%`;
}

function normalizeList(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

async function loadSettings() {
  const raw = await SecureStore.getItemAsync(SETTINGS_KEY);
  if (!raw) return { alpacaMode: 'paper', notifications: true, legionHealthUrl: LEGION_HEALTH_DEFAULT };
  try {
    return { alpacaMode: 'paper', notifications: true, legionHealthUrl: LEGION_HEALTH_DEFAULT, ...JSON.parse(raw) };
  } catch {
    return { alpacaMode: 'paper', notifications: true, legionHealthUrl: LEGION_HEALTH_DEFAULT };
  }
}

async function saveSettings(settings) {
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(settings));
}

function makeApi(token, settings) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  async function request(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { text };
      }
    }
    if (!res.ok) {
      throw new Error(data?.message || data?.error || `${res.status} ${res.statusText}`);
    }
    return data;
  }

  return {
    request,
    login: (email, password) =>
      request(`${DASHBOARD_API_DEFAULT}/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    registerDevice: (expoPushToken) =>
      request(`${DASHBOARD_API_DEFAULT}/devices/register`, {
        method: 'POST',
        body: JSON.stringify({ token: expoPushToken, platform: Platform.OS }),
      }),
    legionStatus: () => request(settings.legionHealthUrl || LEGION_HEALTH_DEFAULT),
    wakeLegion: () => request(`${DASHBOARD_API_DEFAULT}/legion/wake`, { method: 'POST' }),
    shutdownLegion: () => request(`${DASHBOARD_API_DEFAULT}/legion/shutdown`, { method: 'POST' }),
    activeAgents: () => request(`${DASHBOARD_API_DEFAULT}/agents/active`),
    stopAgent: (id) => request(`${DASHBOARD_API_DEFAULT}/agents/${id}/stop`, { method: 'POST' }),
    launchAgent: (payload) =>
      request(`${DASHBOARD_API_DEFAULT}/agents/launch`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    agentLogs: (id) => request(`${DASHBOARD_API_DEFAULT}/agents/${id}/logs`),
    stats: () => request(`${DASHBOARD_API_DEFAULT}/stats`),
    activity: () => request(`${DASHBOARD_API_DEFAULT}/activity?limit=10`),
    signals: () => request(`${INVEST_URL}/signals`),
    news: (ticker) => request(`${INVEST_URL}/news/${encodeURIComponent(ticker)}`),
    portfolio: () => request(`${INVEST_URL}/portfolio`),
    trade: (signal) =>
      request(`${INVEST_URL}/trade`, {
        method: 'POST',
        body: JSON.stringify(signal),
      }),
    githubRepos: () => request('https://api.github.com/users/Lordsleezy/repos?sort=updated&per_page=100'),
  };
}

function Panel({ children, style }) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

function Button({ label, onPress, tone = 'primary', disabled = false, style }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[`button_${tone}`],
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}>
      <Text style={[styles.buttonText, tone === 'ghost' && styles.buttonTextGhost]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function Field({ label, value, onChangeText, secureTextEntry, multiline, placeholder, keyboardType }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#64748b"
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize="none"
        style={[styles.input, multiline && styles.textarea]}
      />
    </View>
  );
}

function Badge({ children, tone = 'muted' }) {
  return (
    <View style={[styles.badge, styles[`badge_${tone}`]]}>
      <Text style={[styles.badgeText, tone === 'danger' && styles.badgeTextDanger]}>{children}</Text>
    </View>
  );
}

function Skeleton({ rows = 3 }) {
  return (
    <View style={styles.skeletonWrap}>
      {Array.from({ length: rows }).map((_, index) => (
        <View key={index} style={[styles.skeleton, { width: `${92 - index * 9}%` }]} />
      ))}
    </View>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <Panel style={styles.errorPanel}>
      <Text style={styles.errorTitle}>Unable to load</Text>
      <Text style={styles.muted}>{message}</Text>
      <Button label="Retry" onPress={onRetry} tone="secondary" style={styles.retryButton} />
    </Panel>
  );
}

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await makeApi(null, { legionHealthUrl: LEGION_HEALTH_DEFAULT }).login(email.trim(), password);
      const token = data?.token || data?.sessionToken || data?.access_token || data?.accessToken;
      if (!token) throw new Error('Login succeeded, but no session token was returned.');
      await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
      onLogin(token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.loginRoot}>
      <StatusBar style="light" />
      <View style={styles.loginBox}>
        <Text style={styles.brand}>Sentinel Command</Text>
        <Text style={styles.subhead}>Secure mobile control for Sentinel Prime.</Text>
        <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="paul@example.com" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry placeholder="Password" />
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <Button label={loading ? 'Authenticating...' : 'Login'} onPress={submit} disabled={loading || !email || !password} />
      </View>
    </KeyboardAvoidingView>
  );
}

function HomeScreen({ api, token, settings }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [legion, setLegion] = useState({ online: false });
  const [agents, setAgents] = useState([]);
  const [stats, setStats] = useState({});
  const [activity, setActivity] = useState([]);

  const load = useCallback(async () => {
    setError('');
    try {
      const [legionResult, agentsResult, statsResult, activityResult] = await Promise.allSettled([
        api.legionStatus(),
        api.activeAgents(),
        api.stats(),
        api.activity(),
      ]);
      setLegion(
        legionResult.status === 'fulfilled'
          ? { online: true, ...(legionResult.value || {}) }
          : { online: false, error: legionResult.reason?.message },
      );
      setAgents(agentsResult.status === 'fulfilled' ? normalizeList(agentsResult.value, ['agents', 'jobs']) : fallbackAgents);
      setStats(statsResult.status === 'fulfilled' ? statsResult.value || {} : {});
      setActivity(activityResult.status === 'fulfilled' ? normalizeList(activityResult.value, ['activity', 'events']).slice(0, 10) : fallbackActivity);
      if (legionResult.status === 'rejected') setError(legionResult.reason?.message || 'Legion status failed.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load, token, settings.legionHealthUrl]);

  const confirmShutdown = () => {
    Alert.alert('Shutdown Legion?', 'This will request a controlled shutdown through the dashboard API.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Shutdown',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.shutdownLegion();
            await load();
          } catch (err) {
            Alert.alert('Shutdown failed', err.message);
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Skeleton rows={8} />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#2dd4bf" />}>
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      <Panel>
        <View style={styles.rowBetween}>
          <View>
            <Text style={styles.panelTitle}>Legion</Text>
            <Text style={styles.muted}>{settings.legionHealthUrl || LEGION_HEALTH_DEFAULT}</Text>
          </View>
          <Badge tone={legion.online ? 'success' : 'danger'}>{legion.online ? 'Online' : 'Offline'}</Badge>
        </View>
        <View style={styles.actions}>
          <Button label="Wake" onPress={async () => { await api.wakeLegion(); load(); }} tone="secondary" />
          <Button label="Shutdown" onPress={confirmShutdown} tone="danger" />
        </View>
      </Panel>

      <View style={styles.statsGrid}>
        <Panel style={styles.statCard}>
          <Text style={styles.statValue}>{stats.productsListedToday ?? stats.products_listed_today ?? 0}</Text>
          <Text style={styles.muted}>Products today</Text>
        </Panel>
        <Panel style={styles.statCard}>
          <Text style={styles.statValue}>{stats.openTrades ?? stats.open_trades ?? 0}</Text>
          <Text style={styles.muted}>Open trades</Text>
        </Panel>
        <Panel style={styles.statCard}>
          <Text style={styles.statValue}>{stats.pendingSignals ?? stats.pending_signals ?? 0}</Text>
          <Text style={styles.muted}>Pending signals</Text>
        </Panel>
      </View>

      <Panel>
        <Text style={styles.panelTitle}>Active agents</Text>
        <FlatList
          data={agents}
          keyExtractor={(item, index) => String(item.id || item.jobId || `${item.name}-${index}`)}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.muted}>No running jobs.</Text>}
          renderItem={({ item }) => (
            <View style={styles.listRow}>
              <View style={styles.flex}>
                <Text style={styles.itemTitle}>{item.name || item.agent || 'Agent'}</Text>
                <Text style={styles.muted}>{item.status || 'unknown'} - {compactTime(item.startedAt || item.started_at)}</Text>
              </View>
              <Button label="Stop" tone="danger" onPress={() => api.stopAgent(item.id || item.jobId).then(load).catch((err) => Alert.alert('Stop failed', err.message))} style={styles.smallButton} />
            </View>
          )}
        />
      </Panel>

      <Panel>
        <Text style={styles.panelTitle}>Recent activity</Text>
        <FlatList
          data={activity}
          keyExtractor={(item, index) => String(item.id || `${item.service}-${index}`)}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <View style={styles.activityRow}>
              <Text style={styles.itemTitle}>{item.service || item.type || 'Sentinel'}</Text>
              <Text style={styles.muted}>{item.message || item.event || item.description}</Text>
              <Text style={styles.timestamp}>{compactTime(item.time || item.createdAt || item.created_at)}</Text>
            </View>
          )}
        />
      </Panel>
    </ScrollView>
  );
}

function InvestScreen({ api }) {
  const [view, setView] = useState('signals');
  const [signals, setSignals] = useState([]);
  const [portfolio, setPortfolio] = useState(null);
  const [selected, setSelected] = useState(null);
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [signalsData, portfolioData] = await Promise.allSettled([api.signals(), api.portfolio()]);
      if (signalsData.status === 'fulfilled') setSignals(normalizeList(signalsData.value, ['signals']));
      else {
        setSignals(fallbackSignals);
        setError(signalsData.reason?.message || 'Signals endpoint failed.');
      }
      if (portfolioData.status === 'fulfilled') setPortfolio(portfolioData.value);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const openSignal = async (signal) => {
    setSelected(signal);
    setNews([]);
    try {
      const data = await api.news(signal.ticker);
      setNews(normalizeList(data, ['news', 'headlines']).slice(0, 5));
    } catch {
      setNews([{ title: `${signal.ticker} news feed unavailable`, sentiment: 'neutral' }]);
    }
  };

  if (loading) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Skeleton rows={9} />
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.segment}>
        <Pressable onPress={() => setView('signals')} style={[styles.segmentItem, view === 'signals' && styles.segmentActive]}>
          <Text style={styles.segmentText}>Signals</Text>
        </Pressable>
        <Pressable onPress={() => setView('portfolio')} style={[styles.segmentItem, view === 'portfolio' && styles.segmentActive]}>
          <Text style={styles.segmentText}>Portfolio</Text>
        </Pressable>
      </View>
      {error ? <View style={styles.contentTight}><ErrorState message={error} onRetry={load} /></View> : null}
      {view === 'signals' ? (
        <FlatList
          data={signals}
          keyExtractor={(item, index) => String(item.id || item.ticker || index)}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <Pressable onPress={() => openSignal(item)} style={styles.signalCard}>
              <View style={styles.rowBetween}>
                <View>
                  <Text style={styles.signalTicker}>{item.ticker}</Text>
                  <Text style={styles.muted}>Entry {money(item.entry)} - Target {money(item.target)} - Stop {money(item.stop)}</Text>
                </View>
                <View style={styles.alignEnd}>
                  <Badge tone={String(item.direction).toUpperCase() === 'SHORT' ? 'warning' : 'success'}>{item.direction || 'LONG'}</Badge>
                  <Badge tone={Number(item.confidence) > 80 ? 'danger' : 'muted'}>{pct(item.confidence)}</Badge>
                </View>
              </View>
            </Pressable>
          )}
        />
      ) : (
        <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
          <Panel>
            <Text style={styles.panelTitle}>P&L</Text>
            <Text style={[styles.statValue, Number(portfolio?.pnl) < 0 && styles.negative]}>{money(portfolio?.pnl ?? portfolio?.profitLoss ?? 0)}</Text>
          </Panel>
          <Panel>
            <Text style={styles.panelTitle}>Open positions</Text>
            <FlatList
              data={normalizeList(portfolio, ['positions', 'openPositions'])}
              keyExtractor={(item, index) => String(item.id || item.ticker || index)}
              scrollEnabled={false}
              ListEmptyComponent={<Text style={styles.muted}>No open positions reported.</Text>}
              renderItem={({ item }) => <Text style={styles.itemTitle}>{item.ticker || item.symbol} - {item.qty || item.quantity} - {money(item.marketValue || item.value)}</Text>}
            />
          </Panel>
          <Panel>
            <Text style={styles.panelTitle}>Trade history</Text>
            <FlatList
              data={normalizeList(portfolio, ['history', 'trades'])}
              keyExtractor={(item, index) => String(item.id || index)}
              scrollEnabled={false}
              ListEmptyComponent={<Text style={styles.muted}>No trades reported.</Text>}
              renderItem={({ item }) => <Text style={styles.itemTitle}>{compactTime(item.time || item.createdAt)} - {item.ticker || item.symbol} - {item.side || item.action}</Text>}
            />
          </Panel>
        </ScrollView>
      )}
      <TradeBriefing signal={selected} news={news} onClose={() => setSelected(null)} onApprove={(signal) => api.trade(signal)} />
    </View>
  );
}

function TradeBriefing({ signal, news, onClose, onApprove }) {
  if (!signal) return null;
  const technicals = signal.technicals || signal.technical || {};
  const bullCase = signal.bullCase || signal.bull_case || [];
  const bearCase = signal.bearCase || signal.bear_case || [];
  const rr = Math.abs(Number(signal.target) - Number(signal.entry)) / Math.max(0.01, Math.abs(Number(signal.entry) - Number(signal.stop)));

  const approve = () => {
    Alert.alert('Approve trade?', `${signal.ticker} ${signal.direction || 'LONG'} at ${money(signal.entry)}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Approve',
        onPress: async () => {
          try {
            await onApprove(signal);
            onClose();
          } catch (err) {
            Alert.alert('Trade failed', err.message);
          }
        },
      },
    ]);
  };

  return (
    <Modal animationType="slide" visible transparent>
      <View style={styles.modalShade}>
        <View style={styles.modalSheet}>
          <ScrollView>
            <View style={styles.rowBetween}>
              <Text style={styles.modalTitle}>{signal.ticker} Briefing</Text>
              <Button label="Close" onPress={onClose} tone="ghost" style={styles.smallButton} />
            </View>
            <Panel>
              <Text style={styles.panelTitle}>Technical summary</Text>
              <Text style={styles.itemTitle}>RSI: {technicals.rsi ?? '-'}</Text>
              <Text style={styles.itemTitle}>MACD: {technicals.macd ?? '-'}</Text>
              <Text style={styles.itemTitle}>Volume: {technicals.volume ?? '-'}</Text>
            </Panel>
            <Panel>
              <Text style={styles.panelTitle}>News</Text>
              {news.map((item, index) => (
                <View key={String(item.id || index)} style={styles.newsRow}>
                  <Text style={styles.itemTitle}>{item.title || item.headline}</Text>
                  <Badge tone={item.sentiment === 'negative' ? 'danger' : item.sentiment === 'positive' ? 'success' : 'muted'}>
                    {item.sentiment || 'neutral'}
                  </Badge>
                </View>
              ))}
            </Panel>
            <Panel>
              <Text style={styles.panelTitle}>Bull case</Text>
              {(bullCase.length ? bullCase : ['No bull case supplied.']).map((item, index) => <Text key={index} style={styles.bullet}>- {item}</Text>)}
            </Panel>
            <Panel>
              <Text style={styles.panelTitle}>Bear case</Text>
              {(bearCase.length ? bearCase : ['No bear case supplied.']).map((item, index) => <Text key={index} style={styles.bullet}>- {item}</Text>)}
            </Panel>
            <Panel>
              <Text style={styles.panelTitle}>Risk / reward</Text>
              <Text style={styles.itemTitle}>Entry {money(signal.entry)} - Target {money(signal.target)} - Stop {money(signal.stop)}</Text>
              <Text style={styles.itemTitle}>R/R {Number.isFinite(rr) ? rr.toFixed(2) : '-'}</Text>
            </Panel>
            <View style={styles.actions}>
              <Button label="Approve Trade" onPress={approve} />
              <Button label="Pass" onPress={onClose} tone="secondary" />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function AgentsScreen({ api, openClaudeTab }) {
  const [repos, setRepos] = useState([]);
  const [repo, setRepo] = useState('');
  const [agent, setAgent] = useState('Codex');
  const [prompt, setPrompt] = useState('');
  const [agents, setAgents] = useState([]);
  const [detail, setDetail] = useState(null);
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [reposData, agentsData] = await Promise.allSettled([api.githubRepos(), api.activeAgents()]);
      if (reposData.status === 'fulfilled') {
        const names = normalizeList(reposData.value).map((item) => item.name).filter(Boolean);
        setRepos(names);
        if (!repo && names.length) setRepo(names[0]);
      }
      setAgents(agentsData.status === 'fulfilled' ? normalizeList(agentsData.value, ['agents', 'jobs']) : fallbackAgents);
    } finally {
      setLoading(false);
    }
  }, [api, repo]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const timer = setInterval(async () => {
      const shared = await SecureStore.getItemAsync(SHARED_PROMPT_KEY);
      if (shared) {
        setPrompt(shared);
        await SecureStore.deleteItemAsync(SHARED_PROMPT_KEY);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const launch = async () => {
    try {
      await api.launchAgent({ repo, agent, prompt, legion: { host: '192.168.0.117', user: 'pgg12' } });
      setPrompt('');
      await load();
    } catch (err) {
      Alert.alert('Launch failed', err.message);
    }
  };

  const openDetail = async (item) => {
    setDetail(item);
    setLogs('Loading logs...');
    try {
      const data = await api.agentLogs(item.id || item.jobId);
      setLogs(data?.logs || data?.text || JSON.stringify(data, null, 2));
    } catch (err) {
      setLogs(err.message);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Panel>
        <Text style={styles.panelTitle}>Launch Agent</Text>
        <Text style={styles.label}>Repo</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
          {(repos.length ? repos : ['sentinel-command']).map((name) => (
            <Pressable key={name} onPress={() => setRepo(name)} style={[styles.chip, repo === name && styles.chipActive]}>
              <Text style={styles.chipText}>{name}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Text style={styles.label}>Agent</Text>
        <View style={styles.chipRow}>
          {['Codex', 'Cursor', 'Cline'].map((name) => (
            <Pressable key={name} onPress={() => setAgent(name)} style={[styles.chip, agent === name && styles.chipActive]}>
              <Text style={styles.chipText}>{name}</Text>
            </Pressable>
          ))}
        </View>
        <Field label="Prompt" value={prompt} onChangeText={setPrompt} multiline placeholder="Describe the job for the selected agent." />
        <View style={styles.actions}>
          <Button label="Get Prompt from Claude" onPress={() => openClaudeTab(prompt)} tone="secondary" />
          <Button label="Launch" onPress={launch} disabled={!repo || !prompt.trim()} />
        </View>
      </Panel>

      <Panel>
        <View style={styles.rowBetween}>
          <Text style={styles.panelTitle}>Active agents</Text>
          {loading ? <ActivityIndicator color="#2dd4bf" /> : null}
        </View>
        <FlatList
          data={agents}
          keyExtractor={(item, index) => String(item.id || item.jobId || index)}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.muted}>No active agents.</Text>}
          renderItem={({ item }) => (
            <Pressable onPress={() => openDetail(item)} style={styles.listRow}>
              <View style={styles.flex}>
                <Text style={styles.itemTitle}>{item.agent || item.name || 'Agent'} on {item.repo || 'repo'}</Text>
                <Text style={styles.muted}>{item.status || 'unknown'} - {compactTime(item.startedAt || item.started_at)}</Text>
              </View>
              <Badge>{item.status || 'live'}</Badge>
            </Pressable>
          )}
        />
      </Panel>

      <Modal visible={Boolean(detail)} animationType="slide" transparent>
        <View style={styles.modalShade}>
          <View style={styles.modalSheet}>
            <View style={styles.rowBetween}>
              <Text style={styles.modalTitle}>{detail?.agent || detail?.name || 'Agent'} Logs</Text>
              <Button label="Close" onPress={() => setDetail(null)} tone="ghost" style={styles.smallButton} />
            </View>
            <ScrollView style={styles.logBox}>
              <Text style={styles.logText}>{logs}</Text>
            </ScrollView>
            <View style={styles.actions}>
              <Button label="Stop" tone="danger" onPress={() => api.stopAgent(detail?.id || detail?.jobId).then(() => { setDetail(null); load(); })} />
              <Button label="Redirect prompt" tone="secondary" onPress={() => { setPrompt(`Continue this job with the following context:\n\n${logs}`); setDetail(null); }} />
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function ClaudeScreen({ initialPrompt = '', onShareToAgent }) {
  const [apiKey, setApiKey] = useState('');
  const [input, setInput] = useState(initialPrompt);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(ANTHROPIC_KEY).then((key) => setApiKey(key || ''));
  }, []);

  useEffect(() => {
    if (initialPrompt) setInput(initialPrompt);
  }, [initialPrompt]);

  const send = async () => {
    if (!input.trim()) return;
    if (!apiKey) {
      Alert.alert('Anthropic key required', 'Add your Anthropic API key in Settings first.');
      return;
    }
    const userMessage = { role: 'user', content: input.trim() };
    const next = [...messages, userMessage];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1200,
          system: SYSTEM_PROMPT,
          messages: next.map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `${res.status} ${res.statusText}`);
      const text = data?.content?.map((part) => part.text).filter(Boolean).join('\n') || '';
      setMessages([...next, { role: 'assistant', content: text }]);
    } catch (err) {
      setMessages([...next, { role: 'assistant', content: `Claude request failed: ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  const voiceInput = () => {
    Speech.speak('Voice capture needs a speech recognition module. Dictate your prompt into the text field for now.', {
      rate: 0.95,
    });
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
      <FlatList
        data={messages}
        keyExtractor={(_, index) => String(index)}
        contentContainerStyle={styles.chatContent}
        ListEmptyComponent={
          <Panel>
            <Text style={styles.panelTitle}>Claude Chat</Text>
            <Text style={styles.muted}>Ask for strategy, debugging help, or a ready-to-run agent prompt.</Text>
          </Panel>
        }
        renderItem={({ item }) => (
          <View style={[styles.message, item.role === 'user' ? styles.messageUser : styles.messageAssistant]}>
            <Text style={styles.messageRole}>{item.role === 'user' ? 'Paul' : 'Claude'}</Text>
            <Text style={styles.messageText}>{item.content}</Text>
            {item.role === 'assistant' ? <Button label="Share to Agent" tone="ghost" onPress={() => onShareToAgent(item.content)} style={styles.shareButton} /> : null}
          </View>
        )}
      />
      <View style={styles.composer}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Message Claude"
          placeholderTextColor="#64748b"
          multiline
          style={styles.composerInput}
        />
        <Button label="Voice" onPress={voiceInput} tone="secondary" style={styles.composerButton} />
        <Button label={loading ? '...' : 'Send'} onPress={send} disabled={loading} style={styles.composerButton} />
      </View>
    </KeyboardAvoidingView>
  );
}

function SettingsScreen({ settings, setSettings, onLogout }) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(ANTHROPIC_KEY).then((key) => setApiKey(key || ''));
  }, []);

  const persistSettings = async (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
  };

  const saveKey = async () => {
    setSaving(true);
    try {
      if (apiKey.trim()) await SecureStore.setItemAsync(ANTHROPIC_KEY, apiKey.trim());
      else await SecureStore.deleteItemAsync(ANTHROPIC_KEY);
      Alert.alert('Saved', 'Settings updated.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Panel>
        <Text style={styles.panelTitle}>Anthropic</Text>
        <Field label="API key" value={apiKey} onChangeText={setApiKey} secureTextEntry placeholder="sk-ant-..." />
        <Button label={saving ? 'Saving...' : 'Save key'} onPress={saveKey} disabled={saving} />
      </Panel>
      <Panel>
        <Text style={styles.panelTitle}>Trading</Text>
        <View style={styles.rowBetween}>
          <Text style={styles.itemTitle}>Alpaca mode</Text>
          <Pressable onPress={() => persistSettings({ alpacaMode: settings.alpacaMode === 'paper' ? 'live' : 'paper' })} style={styles.modeSwitch}>
            <Text style={styles.modeText}>{settings.alpacaMode === 'paper' ? 'Paper' : 'Live'}</Text>
          </Pressable>
        </View>
      </Panel>
      <Panel>
        <Text style={styles.panelTitle}>Notifications</Text>
        <View style={styles.rowBetween}>
          <Text style={styles.itemTitle}>Push alerts</Text>
          <Switch
            value={Boolean(settings.notifications)}
            onValueChange={(value) => persistSettings({ notifications: value })}
            thumbColor={settings.notifications ? '#2dd4bf' : '#94a3b8'}
          />
        </View>
      </Panel>
      <Panel>
        <Text style={styles.panelTitle}>Legion</Text>
        <Field
          label="Health URL"
          value={settings.legionHealthUrl}
          onChangeText={(value) => persistSettings({ legionHealthUrl: value })}
          placeholder={LEGION_HEALTH_DEFAULT}
        />
      </Panel>
      <Button label="Logout" tone="danger" onPress={onLogout} />
    </ScrollView>
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [token, setToken] = useState(null);
  const [tab, setTab] = useState('home');
  const [settings, setSettings] = useState({ alpacaMode: 'paper', notifications: true, legionHealthUrl: LEGION_HEALTH_DEFAULT });
  const [claudePrompt, setClaudePrompt] = useState('');
  const lastLegionOnline = useRef(null);
  const api = useMemo(() => makeApi(token, settings), [token, settings]);

  useEffect(() => {
    (async () => {
      const [storedToken, storedSettings] = await Promise.all([SecureStore.getItemAsync(AUTH_TOKEN_KEY), loadSettings()]);
      setToken(storedToken);
      setSettings(storedSettings);
      setBooting(false);
    })();
  }, []);

  useEffect(() => {
    if (!token || !settings.notifications) return;
    (async () => {
      const permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) return;
      const tokenResult = await Notifications.getExpoPushTokenAsync();
      try {
        await api.registerDevice(tokenResult.data);
      } catch (err) {
        console.warn('Device registration failed', err.message);
      }
    })();
  }, [api, settings.notifications, token]);

  useEffect(() => {
    if (!token || !settings.notifications) return;
    const timer = setInterval(async () => {
      try {
        await api.legionStatus();
        lastLegionOnline.current = true;
      } catch {
        if (lastLegionOnline.current === true) {
          await Notifications.scheduleNotificationAsync({
            content: { title: 'Legion is offline', body: 'Legion went offline unexpectedly.', data: { screen: 'home' } },
            trigger: null,
          });
        }
        lastLegionOnline.current = false;
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [api, settings.notifications, token]);

  const shareToAgent = async (text) => {
    await SecureStore.setItemAsync(SHARED_PROMPT_KEY, text);
    setTab('agents');
  };

  const logout = async () => {
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
    setToken(null);
  };

  if (booting) {
    return (
      <View style={styles.centerScreen}>
        <StatusBar style="light" />
        <ActivityIndicator color="#2dd4bf" />
      </View>
    );
  }

  if (!token) return <LoginScreen onLogin={setToken} />;

  return (
    <View style={styles.app}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Sentinel Command</Text>
          <Text style={styles.headerSub}>{SCOUT_URL.replace('https://', '')} - {LISTER_URL.replace('https://', '')}</Text>
        </View>
      </View>
      <View style={styles.main}>
        {tab === 'home' ? <HomeScreen api={api} token={token} settings={settings} /> : null}
        {tab === 'invest' ? <InvestScreen api={api} /> : null}
        {tab === 'agents' ? <AgentsScreen api={api} openClaudeTab={(prompt) => { setClaudePrompt(prompt); setTab('claude'); }} /> : null}
        {tab === 'claude' ? <ClaudeScreen initialPrompt={claudePrompt} onShareToAgent={shareToAgent} /> : null}
        {tab === 'settings' ? <SettingsScreen settings={settings} setSettings={setSettings} onLogout={logout} /> : null}
      </View>
      <View style={styles.tabBar}>
        {TABS.map((item) => (
          <Pressable key={item.id} onPress={() => setTab(item.id)} style={[styles.tabItem, tab === item.id && styles.tabActive]}>
            <Text style={[styles.tabText, tab === item.id && styles.tabTextActive]} numberOfLines={1}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: '#06111f' },
  centerScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#06111f' },
  loginRoot: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: '#06111f' },
  loginBox: { gap: 14 },
  brand: { color: '#f8fafc', fontSize: 34, fontWeight: '800', letterSpacing: 0 },
  subhead: { color: '#94a3b8', fontSize: 15, marginBottom: 12 },
  header: {
    paddingTop: Platform.OS === 'ios' ? 58 : 34,
    paddingHorizontal: 18,
    paddingBottom: 14,
    backgroundColor: '#071827',
    borderBottomWidth: 1,
    borderBottomColor: '#123041',
  },
  headerTitle: { color: '#f8fafc', fontSize: 22, fontWeight: '800', letterSpacing: 0 },
  headerSub: { color: '#5eead4', fontSize: 12, marginTop: 2 },
  main: { flex: 1 },
  screen: { flex: 1, backgroundColor: '#06111f' },
  content: { padding: 14, gap: 12, paddingBottom: 26 },
  contentTight: { paddingHorizontal: 14 },
  panel: {
    backgroundColor: '#0b1f31',
    borderWidth: 1,
    borderColor: '#16364a',
    borderRadius: 8,
    padding: 14,
    gap: 10,
  },
  panelTitle: { color: '#f8fafc', fontSize: 17, fontWeight: '800', letterSpacing: 0 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  alignEnd: { alignItems: 'flex-end', gap: 6 },
  muted: { color: '#94a3b8', fontSize: 13, lineHeight: 19 },
  timestamp: { color: '#64748b', fontSize: 12, marginTop: 3 },
  label: { color: '#cbd5e1', fontSize: 13, fontWeight: '700', marginBottom: 6 },
  fieldWrap: { gap: 6 },
  input: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1f475e',
    backgroundColor: '#071827',
    color: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  textarea: { minHeight: 130, textAlignVertical: 'top' },
  button: {
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  button_primary: { backgroundColor: '#0f766e', borderColor: '#2dd4bf' },
  button_secondary: { backgroundColor: '#123041', borderColor: '#2a5369' },
  button_danger: { backgroundColor: '#7f1d1d', borderColor: '#ef4444' },
  button_ghost: { backgroundColor: 'transparent', borderColor: '#25465a' },
  buttonDisabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
  buttonText: { color: '#f8fafc', fontWeight: '800', fontSize: 14 },
  buttonTextGhost: { color: '#5eead4' },
  smallButton: { minHeight: 36, paddingHorizontal: 10 },
  retryButton: { alignSelf: 'flex-start' },
  actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  badge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, alignSelf: 'flex-start', borderWidth: 1 },
  badge_muted: { backgroundColor: '#122033', borderColor: '#334155' },
  badge_success: { backgroundColor: '#064e3b', borderColor: '#2dd4bf' },
  badge_danger: { backgroundColor: '#7f1d1d', borderColor: '#ef4444' },
  badge_warning: { backgroundColor: '#78350f', borderColor: '#f59e0b' },
  badgeText: { color: '#e2e8f0', fontSize: 12, fontWeight: '800' },
  badgeTextDanger: { color: '#fecaca' },
  statsGrid: { flexDirection: 'row', gap: 10 },
  statCard: { flex: 1, minHeight: 92, justifyContent: 'center' },
  statValue: { color: '#f8fafc', fontSize: 27, fontWeight: '900', letterSpacing: 0 },
  negative: { color: '#fca5a5' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#123041' },
  activityRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#123041' },
  itemTitle: { color: '#e2e8f0', fontSize: 14, lineHeight: 20 },
  errorPanel: { borderColor: '#ef4444' },
  errorTitle: { color: '#fecaca', fontSize: 16, fontWeight: '800' },
  errorText: { color: '#fca5a5', fontSize: 13 },
  skeletonWrap: { gap: 12 },
  skeleton: { height: 52, borderRadius: 8, backgroundColor: '#10283a', borderWidth: 1, borderColor: '#17384c' },
  segment: { flexDirection: 'row', gap: 8, padding: 14, paddingBottom: 4 },
  segmentItem: { flex: 1, minHeight: 42, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: '#0b1f31', borderWidth: 1, borderColor: '#16364a' },
  segmentActive: { backgroundColor: '#0f766e', borderColor: '#2dd4bf' },
  segmentText: { color: '#f8fafc', fontWeight: '800' },
  signalCard: { backgroundColor: '#0b1f31', borderWidth: 1, borderColor: '#16364a', borderRadius: 8, padding: 14, marginBottom: 10 },
  signalTicker: { color: '#f8fafc', fontSize: 22, fontWeight: '900', letterSpacing: 0 },
  modalShade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  modalSheet: { maxHeight: '92%', backgroundColor: '#06111f', borderTopLeftRadius: 14, borderTopRightRadius: 14, padding: 14, gap: 12, borderWidth: 1, borderColor: '#16364a' },
  modalTitle: { color: '#f8fafc', fontSize: 21, fontWeight: '900', letterSpacing: 0 },
  newsRow: { gap: 8, paddingVertical: 8 },
  bullet: { color: '#e2e8f0', fontSize: 14, lineHeight: 21 },
  chips: { marginBottom: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: { borderRadius: 8, borderWidth: 1, borderColor: '#25465a', paddingHorizontal: 11, paddingVertical: 8, marginRight: 8, backgroundColor: '#071827' },
  chipActive: { backgroundColor: '#0f766e', borderColor: '#2dd4bf' },
  chipText: { color: '#f8fafc', fontWeight: '700' },
  logBox: { maxHeight: 360, backgroundColor: '#020617', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#1e293b' },
  logText: { color: '#cbd5e1', fontFamily: Platform.select({ ios: 'Courier New', android: 'monospace' }), fontSize: 12, lineHeight: 18 },
  chatContent: { padding: 14, gap: 12, paddingBottom: 20 },
  message: { borderRadius: 8, borderWidth: 1, padding: 12, gap: 8 },
  messageUser: { backgroundColor: '#10283a', borderColor: '#27526b' },
  messageAssistant: { backgroundColor: '#0b1f31', borderColor: '#2dd4bf' },
  messageRole: { color: '#5eead4', fontSize: 12, fontWeight: '900' },
  messageText: { color: '#f8fafc', fontSize: 15, lineHeight: 22 },
  shareButton: { alignSelf: 'flex-start' },
  composer: { borderTopWidth: 1, borderTopColor: '#123041', padding: 10, backgroundColor: '#071827', flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  composerInput: { flex: 1, minHeight: 44, maxHeight: 110, color: '#f8fafc', backgroundColor: '#06111f', borderRadius: 8, borderWidth: 1, borderColor: '#1f475e', paddingHorizontal: 10, paddingVertical: 9 },
  composerButton: { width: 72, minHeight: 44, paddingHorizontal: 6 },
  modeSwitch: { minWidth: 92, minHeight: 40, justifyContent: 'center', alignItems: 'center', borderRadius: 8, borderWidth: 1, borderColor: '#2dd4bf', backgroundColor: '#0f766e' },
  modeText: { color: '#f8fafc', fontWeight: '900' },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 24 : 10,
    backgroundColor: '#071827',
    borderTopWidth: 1,
    borderTopColor: '#123041',
  },
  tabItem: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: '#0b2b3f' },
  tabText: { color: '#94a3b8', fontSize: 12, fontWeight: '800' },
  tabTextActive: { color: '#5eead4' },
});
