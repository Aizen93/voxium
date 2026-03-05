import { useEffect } from 'react';
import { Users, Server, MessageSquare, Wifi, ShieldBan, Mic, Flag, LifeBuoy } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminStatCard } from './AdminStatCard';

export function AdminDashboard() {
  const { stats, liveMetrics, signupData, messagesData, fetchStats, fetchSignups, fetchMessagesPerHour, subscribeMetrics, unsubscribeMetrics } = useAdminStore();

  useEffect(() => {
    fetchStats();
    fetchSignups();
    fetchMessagesPerHour();
    subscribeMetrics();
    return () => unsubscribeMetrics();
  }, [fetchStats, fetchSignups, fetchMessagesPerHour, subscribeMetrics, unsubscribeMetrics]);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-vox-text-primary">Dashboard</h2>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-7 gap-4">
        <AdminStatCard label="Total Users" value={stats?.totalUsers ?? 0} icon={Users} />
        <AdminStatCard label="Total Servers" value={stats?.totalServers ?? 0} icon={Server} color="text-vox-accent-info" />
        <AdminStatCard label="Total Messages" value={stats?.totalMessages ?? 0} icon={MessageSquare} color="text-vox-accent-success" />
        <AdminStatCard label="Online Now" value={liveMetrics?.onlineUsers ?? stats?.onlineUsers ?? 0} icon={Wifi} color="text-green-400" />
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

      {/* Charts */}
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
    </div>
  );
}

function MiniBarChart({ data, labels, color }: { data: number[]; labels: string[]; color: string }) {
  const max = Math.max(...data, 1);
  const barWidth = Math.max(8, Math.min(24, 600 / data.length - 2));
  const chartHeight = 120;
  const chartWidth = data.length * (barWidth + 2);

  return (
    <div className="overflow-x-auto">
      <svg width={chartWidth} height={chartHeight + 20} className="block">
        {data.map((value, i) => {
          const barHeight = (value / max) * chartHeight;
          const x = i * (barWidth + 2);
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
              />
              {data.length <= 30 && (
                <text x={x + barWidth / 2} y={chartHeight + 12} textAnchor="middle" className="fill-vox-text-muted" fontSize={8}>
                  {labels[i]}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
