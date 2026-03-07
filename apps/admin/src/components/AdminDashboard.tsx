import { useEffect, useRef, useState } from 'react';
import { Users, Server, MessageSquare, Wifi, ShieldBan, Mic, Flag, LifeBuoy, MessageCircle, UserCheck } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminStatCard } from './AdminStatCard';

export function AdminDashboard() {
  const {
    stats, liveMetrics, signupData, messagesData, serverGrowthData, topServers,
    fetchStats, fetchSignups, fetchMessagesPerHour, fetchServerGrowth, fetchTopServers,
    subscribeMetrics, unsubscribeMetrics,
  } = useAdminStore();

  useEffect(() => {
    fetchStats();
    fetchSignups();
    fetchMessagesPerHour();
    fetchServerGrowth();
    fetchTopServers();
    subscribeMetrics();
    return () => unsubscribeMetrics();
  }, [fetchStats, fetchSignups, fetchMessagesPerHour, fetchServerGrowth, fetchTopServers, subscribeMetrics, unsubscribeMetrics]);

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

      {/* Live Metrics */}
      {liveMetrics && (
        <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
          <h3 className="text-sm font-semibold text-vox-text-primary mb-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
            Live Metrics
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
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
        </div>
      )}

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

  const ticks = [0, Math.round(max / 2), max];

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
