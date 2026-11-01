import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useProject } from '../../lib/ProjectContext';
import { Card } from '../ui/Card';

// Inline project picker for the 3 mobile report screens (Task/Weekly/Monthly
// Report) — same tap-to-expand dropdown pattern already used by
// flowchart-templates/apply/[templateId].tsx's own "Target Project" picker,
// reused here rather than inventing a second style. Added so picking a
// project (and switching it) happens right on the report screen itself,
// not only via a prior trip to Home — these screens used to silently
// <Redirect href="/home" /> whenever nothing was selected yet, which from
// the drawer just looked like the report link did nothing.
// "Tue 27 Oct · 11:42 AM"
function formatNow(d: Date): string {
  const day = `${d.toLocaleString('en-US', { weekday: 'short' })} ${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}`;
  return `${day} · ${d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

// variant="title": the project name as the report's big heading (still
// tappable to switch project), with today's date + time underneath.
export function ReportProjectPicker({ variant = 'field' }: { variant?: 'field' | 'title' }) {
  const { projects, selectedProjectId, setSelectedProjectId } = useProject();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const selectedName = projects.find((p) => p.id === selectedProjectId)?.name ?? null;

  useEffect(() => {
    if (variant !== 'title') return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [variant]);

  return (
    <Card className={variant === 'title' ? 'mb-2' : 'mb-3'} style={variant === 'title' ? { paddingHorizontal: 12, paddingVertical: 8 } : undefined}>
      {variant === 'title' ? (
        <Pressable onPress={() => setOpen((v) => !v)}>
          <View className="flex-row items-center justify-between">
            <Text className={`text-xl font-extrabold flex-1 pr-2 ${selectedName ? 'text-neutral-900' : 'text-neutral-400'}`}>
              {selectedName ?? 'Select a project'}
            </Text>
            <Text className="text-neutral-400">{open ? '▲' : '▼'}</Text>
          </View>
          <Text className="text-xs font-semibold text-neutral-500">{formatNow(now)}</Text>
        </Pressable>
      ) : (
        <>
          <Text className="text-2xs text-neutral-400 mb-1">Project</Text>
          <Pressable
            onPress={() => setOpen((v) => !v)}
            className="flex-row items-center justify-between border border-neutral-200 rounded-lg px-3 py-2.5 bg-white"
          >
            <Text className={`text-sm ${selectedName ? 'text-neutral-900 font-medium' : 'text-neutral-400'}`}>
              {selectedName ?? 'Select a project'}
            </Text>
            <Text className="text-neutral-400">{open ? '▲' : '▼'}</Text>
          </Pressable>
        </>
      )}
      {open && (
        <View className="mt-2">
          {projects.map((p) => {
            const active = selectedProjectId === p.id;
            return (
              <Pressable
                key={p.id}
                onPress={() => {
                  setSelectedProjectId(p.id);
                  setOpen(false);
                }}
                className={`px-3 py-2 rounded-lg mb-1 ${active ? 'bg-brand-navy' : 'bg-neutral-50'}`}
              >
                <Text className={`text-xs font-medium ${active ? 'text-white' : 'text-neutral-700'}`}>{p.name}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </Card>
  );
}
