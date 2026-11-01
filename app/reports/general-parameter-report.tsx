import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { Redirect, Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../lib/AuthContext';
import { useProject } from '../../lib/ProjectContext';
import { fetchProjectTaskOptions, type ProjectTaskOption } from '../../lib/reports/taskList';
import { fetchGeneralParameterReport, type GeneralParameterReportData } from '../../lib/reports/generalParameterReport';
import { TaskPicker } from '../../components/reports/TaskPicker';
import { ReportProjectPicker } from '../../components/reports/ReportProjectPicker';
import { GeneralParameterSection } from '../../components/reports/GeneralParameterSection';
import { EmptyState } from '../../components/ui/EmptyState';

// Standalone entry point for the General Parameter report (A-I from the
// spec) — reachable directly from the Reports drawer, not just as a tab
// inside Task Report (that tab is untouched and still there too). Same
// data/PDF export as that tab, via the exact same fetch and component.
export default function GeneralParameterReportScreen() {
  const { state } = useAuth();
  const { projects, selectedProjectId } = useProject();
  const { taskId: taskIdParam } = useLocalSearchParams<{ taskId?: string }>();

  const [options, setOptions] = useState<ProjectTaskOption[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(taskIdParam ?? null);
  const [data, setData] = useState<GeneralParameterReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Project + Task pickers take real space (a card each) — worth it while
  // choosing, wasted once a report is already on screen, especially with
  // the task's own name repeated a second time right below them. Collapses
  // to one tappable summary line the moment a report successfully loads;
  // tapping it re-expands both pickers to change the selection.
  const [pickersExpanded, setPickersExpanded] = useState(true);

  const loadOptions = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      setError(null);
      // flowchartOnly=true — this report's own task picker should only
      // ever offer what the flowchart itself shows, by explicit request.
      setOptions(await fetchProjectTaskOptions(selectedProjectId, true));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    setLoading(true);
    loadOptions();
  }, [loadOptions]);

  const loadReport = useCallback(async () => {
    if (!selectedProjectId || !selectedTaskId) {
      setData(null);
      return;
    }
    try {
      setError(null);
      setReportLoading(true);
      setData(await fetchGeneralParameterReport(selectedTaskId, selectedProjectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReportLoading(false);
    }
  }, [selectedProjectId, selectedTaskId]);

  // On focus too — returning from Edit DPR shows the edited figures.
  useFocusEffect(
    useCallback(() => {
      loadReport();
    }, [loadReport])
  );

  useEffect(() => {
    if (data) setPickersExpanded(false);
  }, [data]);

  if (state.status !== 'signed-in') {
    return <Redirect href="/login" />;
  }

  function handleSelectTask(id: string) {
    setSelectedTaskId(id);
    router.setParams({ taskId: id });
  }

  function retry() {
    loadOptions();
    loadReport();
  }

  // Pull-to-refresh — this screen previously had no way to see a change
  // made outside the app (e.g. a direct DB fix) without a full page
  // reload, since loadReport only ever re-runs when the task/project
  // selection itself changes, never on demand.
  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([loadOptions(), loadReport()]);
    setRefreshing(false);
  }

  return (
    <View className="flex-1 bg-neutral-50">
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Task Based Status',
          headerStyle: { backgroundColor: '#0F1F33' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '600' },
        }}
      />

      {!selectedProjectId ? (
        <ScrollView contentContainerClassName="px-4 pt-4 pb-10">
          <ReportProjectPicker />
          <EmptyState icon="document-text-outline" iconColor="#9CA3AF" title="Select a project" subtitle="Pick a project above to generate its Task Based Report." />
        </ScrollView>
      ) : loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#0F1F33" />
        </View>
      ) : error ? (
        <View className="mx-4 mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3">
          <Text className="text-sm text-red-600 mb-2.5">{error}</Text>
          <Pressable onPress={retry} className="self-start px-3.5 py-1.5 rounded-lg bg-white border border-red-200">
            <Text className="text-xs font-semibold text-red-600">Retry</Text>
          </Pressable>
        </View>
      ) : options.length === 0 ? (
        <ScrollView contentContainerClassName="px-4 pt-4 pb-10">
          <ReportProjectPicker />
          <EmptyState icon="document-text-outline" iconColor="#9CA3AF" title="No tasks in this project yet" />
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerClassName="px-4 pt-4 pb-10"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#0F1F33" />}
        >
          {pickersExpanded || !data ? (
            <>
              <ReportProjectPicker />
              <TaskPicker options={options} selectedTaskId={selectedTaskId} onSelect={handleSelectTask} />
            </>
          ) : (
            <Pressable
              onPress={() => setPickersExpanded(true)}
              className="flex-row items-center justify-between bg-white rounded-2xl border border-neutral-100 px-3.5 py-3 mb-4"
            >
              <View className="flex-1 pr-2">
                <Text className="text-2xs text-neutral-400 mb-0.5">
                  {projects.find((p) => p.id === selectedProjectId)?.name ?? 'Project'}
                </Text>
                <Text className="text-sm font-bold text-neutral-900" numberOfLines={1}>
                  {data.base.task.taskCode} — {data.base.task.taskName}
                </Text>
                <Text className="text-2xs text-neutral-400 mt-0.5" numberOfLines={1}>{data.base.task.workName}</Text>
              </View>
              <View className="flex-row items-center gap-1">
                <Text className="text-2xs font-bold text-brand-amber">Change</Text>
                <Ionicons name="chevron-down" size={14} color="#F0A227" />
              </View>
            </Pressable>
          )}

          {reportLoading ? (
            <View className="items-center py-10">
              <ActivityIndicator color="#0F1F33" />
            </View>
          ) : !selectedTaskId ? null : !data ? (
            <EmptyState
              icon="alert-circle-outline"
              iconColor="#9CA3AF"
              title="Task not found"
              subtitle="It may not belong to this project, or may have been deleted."
            />
          ) : (
            <>
              {/* Admin can open any task's DPR from here — completed ones
                  too, which drop off the DPR list — to edit and resubmit. */}
              {state.profile.role === 'admin' && (
                <Pressable
                  onPress={() => router.push(`/dpr-edit/${data.base.task.id}`)}
                  className="flex-row items-center justify-center gap-1.5 mb-3 py-2.5 rounded-xl bg-brand-navy"
                >
                  <Ionicons name="create-outline" size={16} color="#fff" />
                  <Text className="text-sm font-bold text-white">Edit DPR</Text>
                </Pressable>
              )}
              <GeneralParameterSection data={data} />
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}
