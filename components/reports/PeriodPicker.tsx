import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card } from '../ui/Card';
import { formatDayLabel, monthRange, parseDateKeyUtc, todayKeyUtc, weeksOfMonth, type DateRange } from '../../lib/reports/dateRange';

// Weekly/Monthly Status's period picker — tap "Week 1..5" of a month, or a
// month name, and the report loads straight away (same no-"Generate"-button
// rule as DateRangeBar). The arrows step the month (week mode) or the year
// (month mode). Periods that start after today are disabled.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface PeriodPickerProps {
  mode: 'week' | 'month';
  range: DateRange;
  onChange: (range: DateRange) => void;
}

export function PeriodPicker({ mode, range, onChange }: PeriodPickerProps) {
  const start = parseDateKeyUtc(range.from);
  const [year, setYear] = useState(start.getUTCFullYear());
  const [month0, setMonth0] = useState(start.getUTCMonth());
  const today = todayKeyUtc();

  function step(delta: number) {
    if (mode === 'month') {
      setYear(year + delta);
      return;
    }
    const d = new Date(Date.UTC(year, month0 + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth0(d.getUTCMonth());
  }

  const periods =
    mode === 'week'
      ? weeksOfMonth(year, month0).map((w) => ({ ...w, sub: `${formatDayLabel(w.range.from)}–${Number(w.range.to.slice(8, 10))}` }))
      : MONTHS.map((m, i) => ({ label: m, sub: null as string | null, range: monthRange(year, i) }));

  return (
    <Card className="mb-2" style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
      <View className="flex-row items-center justify-between mb-1.5">
        <Pressable onPress={() => step(-1)} hitSlop={10} className="px-1">
          <Ionicons name="chevron-back" size={18} color="#0F1F33" />
        </Pressable>
        <Text className="text-sm font-bold text-neutral-900">{mode === 'week' ? `${MONTHS_LONG[month0]} ${year}` : year}</Text>
        <Pressable onPress={() => step(1)} hitSlop={10} className="px-1">
          <Ionicons name="chevron-forward" size={18} color="#0F1F33" />
        </Pressable>
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        {periods.map((p) => {
          const selected = p.range.from === range.from && p.range.to === range.to;
          const future = p.range.from > today;
          return (
            <Pressable
              key={p.range.from}
              disabled={future}
              onPress={() => onChange(p.range)}
              className={`items-center rounded-lg px-2 py-1 border ${
                selected ? 'bg-[#0F1F33] border-[#0F1F33]' : 'bg-white border-neutral-200'
              } ${future ? 'opacity-40' : ''}`}
              style={{ minWidth: mode === 'week' ? '18%' : '22%', flexGrow: 1 }}
            >
              <Text className={`text-xs font-bold ${selected ? 'text-white' : 'text-neutral-800'}`}>{p.label}</Text>
              {p.sub && <Text className={`text-2xs ${selected ? 'text-white/70' : 'text-neutral-400'}`}>{p.sub}</Text>}
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}
