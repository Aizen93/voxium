import { useEffect, useRef, useState } from 'react';
import { Users, Server, MessageSquare, Wifi, ShieldBan, Mic, Flag, LifeBuoy, MessageCircle, UserCheck, Cpu, HardDrive, Radio, RefreshCw } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminStatCard } from './AdminStatCard';

export function AdminDashboard() {
  const {
    stats, liveMetrics, sfuStats, signupData, messagesData, serverGrowthData, topServers,
    fetchStats, fetchSignups, fetchMessagesPerHour, fetchServerGrowth, fetchTopServers,
    fetchSfuStats, fetchLiveMetrics,
  } = useAdminStore();
  const [sfuRefreshing, setSfuRefreshing] = useState(false);
  const [metricsRefreshing, setMetricsRefreshing] = useState(false);

  useEffect(() => {
    fetchStats();
    fetchSignups();
    fetchMessagesPerHour();
    fetchServerGrowth();
    fetchTopServers();
    fetchSfuStats();
    fetchLiveMetrics();
  }, [fetchStats, fetchSignups, fetchMessagesPerHour, fetchServerGrowth, fetchTopServers, fetchSfuStats, fetchLiveMetrics]);

  const handleRefreshSfu = async () => {
    setSfuRefreshing(true);
    await fetchSfuStats();
    setSfuRefreshing(false);
  };

  const handleRefreshMetrics = async () => {
    setMetricsRefreshing(true);
    await fetchLiveMetrics();
    setMetricsRefreshing(false);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-vox-text-primary">Dashboard</h2>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-9 gap-4">
        <AdminStatCard label="Total Users" value={stats?.totalUsers ?? 0} icon={Users} />
        <AdminStatCard label="Total Servers" value={stats?.totalServers ?? 0} icon={Server} color="text-vox-accent-info" />
        <AdminStatCard label="Total Messages" value={stats?.totalMessages ?? 0} icon={MessageSquare} color="text-vox-accent-success" />
        <AdminStatCard label="Online Now" value={liveMetrics?.onlineUsers ?? stats?.onlineUsers ?? 0} icon={Wifi} color="text-green-400" />
        <AdminStatCard label="DM Conversations" value={stats?.totalConversations ?? 0} icon={MessageCircle} color="text-purple-400" />
        <AdminStatCard label="Friendships" value={stats?.totalFriendships ?? 0} icon={UserCheck} color="text-cyan-400" />
        <AdminStatCard label="Banned Users" value={stats?.bannedUsers ?? 0} icon={ShieldBan} color="text-vox-accent-danger" />
        <AdminStatCard label="Pending Reports" value={stats?.pendingReports ?? 0} icon={Flag} color="text-vox-accent-warning" />
        <AdminStatCard label="Open Tickets" value={stats?.openTickets ?? 0} icon={LifeBuoy} color="text-vox-accent-info" />
      </div>

      {/* Real-time Metrics */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
        <h3 className="text-sm font-semibold text-vox-text-primary mb-3 flex items-center gap-2">
          <Wifi size={14} className="text-green-400" />
          Real-time Metrics
          <button
            onClick={handleRefreshMetrics}
            disabled={metricsRefreshing}
            className="ml-auto p-1.5 rounded hover:bg-vox-bg-hover text-vox-text-muted hover:text-vox-text-primary transition-colors disabled:opacity-50"
            title="Refresh metrics"
          >
            <RefreshCw size={14} className={metricsRefreshing ? 'animate-spin' : ''} />
          </button>
        </h3>
        {liveMetrics ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <div>
              <p className="text-lg font-bold text-vox-text-primary">{liveMetrics.onlineUsers}</p>
              <p className="text-xs text-vox-text-muted">Online Users</p>
            </div>
            <div>
              <p className="text-lg font-bold text-vox-text-primary">{liveMetrics.voiceChannels}</p>
              <p className="text-xs text-vox-text-muted">Voice Channels</p>
            </div>
            <div>
              <p className="text-lg font-bold text-vox-text-primary">{liveMetrics.voiceUsers}</p>
              <p className="text-xs text-vox-text-muted">In Voice</p>
            </div>
            <div>
              <p className="text-lg font-bold text-vox-text-primary">{liveMetrics.dmCalls}</p>
              <p className="text-xs text-vox-text-muted">DM Calls</p>
            </div>
            <div>
              <p className="text-lg font-bold text-vox-text-primary">{liveMetrics.messagesLastHour}</p>
              <p className="text-xs text-vox-text-muted">Msgs/Hour</p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-vox-text-muted py-4 text-center">Loading metrics...</p>
        )}
      </div>

      {/* SFU Infrastructure */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
        <h3 className="text-sm font-semibold text-vox-text-primary mb-3 flex items-center gap-2">
          <Radio size={14} className="text-vox-accent-info" />
          SFU Infrastructure
          <button
            onClick={handleRefreshSfu}
            disabled={sfuRefreshing}
            className="ml-auto p-1.5 rounded hover:bg-vox-bg-hover text-vox-text-muted hover:text-vox-text-primary transition-colors disabled:opacity-50"
            title="Refresh SFU stats"
          >
            <RefreshCw size={14} className={sfuRefreshing ? 'animate-spin' : ''} />
          </button>
        </h3>

        {sfuStats ? (
          <>
            {/* Aggregate counts */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
              <div>
                <p className="text-lg font-bold text-vox-text-primary">{sfuStats.workers.length}</p>
                <p className="text-xs text-vox-text-muted">Workers</p>
              </div>
              <div>
                <p className="text-lg font-bold text-vox-text-primary">{sfuStats.totalRouters}</p>
                <p className="text-xs text-vox-text-muted">Routers</p>
              </div>
              <div>
                <p className="text-lg font-bold text-vox-text-primary">{sfuStats.totalTransports}</p>
                <p className="text-xs text-vox-text-muted">Transports</p>
              </div>
              <div>
                <p className="text-lg font-bold text-vox-text-primary">{sfuStats.totalProducers}</p>
                <p className="text-xs text-vox-text-muted">Producers</p>
              </div>
              <div>
                <p className="text-lg font-bold text-vox-text-primary">{sfuStats.totalConsumers}</p>
                <p className="text-xs text-vox-text-muted">Consumers</p>
              </div>
              <div>
                <p className="text-lg font-bold text-vox-text-primary">
                  {sfuStats.totalTransports}
                  <span className="text-xs font-normal text-vox-text-muted"> / {sfuStats.portRange.total}</span>
                </p>
                <p className="text-xs text-vox-text-muted">Port Usage</p>
              </div>
            </div>

            {/* Port utilization bar */}
            {(() => {
              const used = sfuStats.totalTransports;
              const total = sfuStats.portRange.total;
              const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
              const color = pct < 50 ? 'bg-green-500' : pct < 80 ? 'bg-yellow-500' : 'bg-red-500';
              return (
                <div className="mb-4">
                  <div className="flex items-center justify-between text-xs text-vox-text-muted mb-1">
                    <span>Global Port Range (shared): {sfuStats.portRange.min}–{sfuStats.portRange.max}</span>
                    <span>{pct.toFixed(1)}% used</span>
                  </div>
                  <div className="h-2 rounded-full bg-vox-bg-hover overflow-hidden">
                    <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })()}

            {/* Per-worker breakdown */}
            {sfuStats.workers.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-vox-text-secondary mb-2">Workers</p>
                <div className="grid gap-2">
                  {sfuStats.workers.map((w, i) => (
                    <div key={`worker-${i}-${w.pid}`} className="flex items-center gap-3 rounded bg-vox-bg-primary px-3 py-2 text-xs">
                      <div className="flex items-center gap-1.5 min-w-[80px]">
                        <Cpu size={12} className="text-vox-text-muted" />
                        <span className="text-vox-text-secondary font-mono">PID {w.pid}</span>
                      </div>
                      <div className="flex items-center gap-1.5 min-w-[90px]">
                        <span className="text-vox-text-muted">Routers:</span>
                        <span className="text-vox-text-primary font-medium">{w.routerCount}</span>
                      </div>
                      <div className="flex items-center gap-1.5 min-w-[100px]">
                        <span className="text-vox-text-muted">Transports:</span>
                        <span className="text-vox-text-primary font-medium">{w.transportCount}</span>
                      </div>
                      <div className="flex items-center gap-1.5 min-w-[120px]">
                        <span className="text-vox-text-muted">CPU:</span>
                        <span className="text-vox-text-primary font-medium">{(w.cpuUser / 1000).toFixed(1)}s</span>
                        <span className="text-vox-text-muted">usr</span>
                        <span className="text-vox-text-primary font-medium">{(w.cpuSystem / 1000).toFixed(1)}s</span>
                        <span className="text-vox-text-muted">sys</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <HardDrive size={12} className="text-vox-text-muted" />
                        <span className="text-vox-text-primary font-medium">{(w.memoryRss / 1024).toFixed(1)} MB</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-vox-text-muted py-4 text-center">Loading SFU stats...</p>
        )}
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Signups Chart */}
        <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
          <h3 className="text-sm font-semibold text-vox-text-primary mb-3 flex items-center gap-2">
            <Users size={14} /> Signups (Last 30 Days)
          </h3>
          {signupData.length > 0 ? (
            <MiniBarChart data={signupData.map((d) => d.count)} labels={signupData.map((d) => d.day.toString().slice(5, 10))} color="#5b5bf7" />
          ) : (
            <p className="text-xs text-vox-text-muted py-8 text-center">No signup data</p>
          )}
        </div>

        {/* Messages/Hour Chart */}
        <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
          <h3 className="text-sm font-semibold text-vox-text-primary mb-3 flex items-center gap-2">
            <Mic size={14} /> Messages Per Hour (Last 24h)
          </h3>
          {messagesData.length > 0 ? (
            <MiniBarChart data={messagesData.map((d) => d.count)} labels={messagesData.map((d) => new Date(d.hour).getHours().toString().padStart(2, '0'))} color="#3eba68" />
          ) : (
            <p className="text-xs text-vox-text-muted py-8 text-center">No message data</p>
          )}
        </div>
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Server Growth Chart */}
        <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
          <h3 className="text-sm font-semibold text-vox-text-primary mb-3 flex items-center gap-2">
            <Server size={14} /> Server Growth (Last 30 Days)
          </h3>
          {serverGrowthData.length > 0 ? (
            <MiniBarChart data={serverGrowthData.map((d) => d.count)} labels={serverGrowthData.map((d) => d.day.toString().slice(5, 10))} color="#38bdf8" />
          ) : (
            <p className="text-xs text-vox-text-muted py-8 text-center">No server data</p>
          )}
        </div>

        {/* Top Servers by Activity */}
        <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
          <h3 className="text-sm font-semibold text-vox-text-primary mb-3 flex items-center gap-2">
            <Server size={14} /> Top Servers by Activity
          </h3>
          {topServers.length > 0 ? (
            <TopServersChart servers={topServers} />
          ) : (
            <p className="text-xs text-vox-text-muted py-8 text-center">No server data</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MiniBarChart({ data, labels, color }: { data: number[]; labels: string[]; color: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const max = Math.max(...data, 1);
  const total = data.reduce((s, v) => s + v, 0);
  const chartHeight = 140;
  const yAxisWidth = 36;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const availableWidth = containerWidth - yAxisWidth;
  const gap = 2;
  const barWidth = availableWidth > 0 ? Math.max(4, (availableWidth - gap * data.length) / data.length) : 10;
  const svgWidth = containerWidth || yAxisWidth + data.length * (barWidth + gap);

  const ticks = [...new Set([0, Math.round(max / 2), max])];

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <span className="text-xs text-vox-text-muted">Total: <span className="font-semibold text-vox-text-primary">{total.toLocaleString()}</span></span>
        <span className="text-xs text-vox-text-muted">Peak: <span className="font-semibold text-vox-text-primary">{max.toLocaleString()}</span></span>
      </div>
      <div ref={containerRef} className="w-full">
        {containerWidth > 0 && (
          <svg width={svgWidth} height={chartHeight + 20} className="block">
            {/* Y-axis labels + grid lines */}
            {ticks.map((tick) => {
              const y = chartHeight - (tick / max) * chartHeight;
              return (
                <g key={tick}>
                  <text x={yAxisWidth - 4} y={y + 3} textAnchor="end" className="fill-vox-text-muted" fontSize={9}>{tick}</text>
                  <line x1={yAxisWidth} y1={y} x2={svgWidth} y2={y} stroke="currentColor" className="text-vox-border" strokeWidth={0.5} strokeDasharray="3,3" />
                </g>
              );
            })}
            {/* Bars */}
            {data.map((value, i) => {
              const barHeight = (value / max) * chartHeight;
              const x = yAxisWidth + i * (barWidth + gap);
              return (
                <g key={i}>
                  <rect
                    x={x}
                    y={chartHeight - barHeight}
                    width={barWidth}
                    height={barHeight}
                    fill={color}
                    opacity={0.8}
                    rx={2}
                  >
                    <title>{labels[i]}: {value}</title>
                  </rect>
                  {value > 0 && data.length <= 15 && (
                    <text x={x + barWidth / 2} y={chartHeight - barHeight - 3} textAnchor="middle" className="fill-vox-text-secondary" fontSize={8}>{value}</text>
                  )}
                  {data.length <= 31 && (
                    <text x={x + barWidth / 2} y={chartHeight + 12} textAnchor="middle" className="fill-vox-text-muted" fontSize={8}>
                      {labels[i]}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

function TopServersChart({ servers }: { servers: Array<{ id: string; name: string; messageCount: number; memberCount: number }> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const maxMessages = Math.max(...servers.map((s) => s.messageCount), 1);
  const barHeight = 26;
  const labelWidth = 120;
  const gap = 8;
  const svgHeight = servers.length * (barHeight + gap);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const chartWidth = Math.max(100, containerWidth - labelWidth);

  return (
    <div ref={containerRef} className="w-full">
      {containerWidth > 0 && (
      <svg width={containerWidth} height={svgHeight} className="block">
        {servers.map((server, i) => {
          const y = i * (barHeight + gap);
          const barW = Math.max(2, (server.messageCount / maxMessages) * (chartWidth * 0.6));
          return (
            <g key={server.id}>
              <text x={labelWidth - 8} y={y + barHeight / 2 + 4} textAnchor="end" className="fill-vox-text-secondary" fontSize={11}>
                {server.name.length > 16 ? server.name.slice(0, 16) + '…' : server.name}
              </text>
              <rect
                x={labelWidth}
                y={y}
                width={barW}
                height={barHeight}
                fill="#5b5bf7"
                opacity={0.7 + (0.3 * (servers.length - i)) / servers.length}
                rx={3}
              >
                <title>{server.name}: {server.messageCount.toLocaleString()} messages, {server.memberCount} members</title>
              </rect>
              <text x={labelWidth + barW + 8} y={y + barHeight / 2 + 4} className="fill-vox-text-muted" fontSize={10}>
                {server.messageCount.toLocaleString()} msgs · {server.memberCount} members
              </text>
            </g>
          );
        })}
      </svg>
      )}
    </div>
  );
}
