import { MOTION_SETTINGS, type MotionSetting, motionPreference } from '../motion.js';
import { usePreference } from '../prefs.js';
import { THEME_SETTINGS, type ThemeSetting, useTheme } from '../theme/theme.js';
import { cx } from '../ui/cx.js';
import { Page, PageHeader } from './Page.js';

const THEME_LABEL: Record<ThemeSetting, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};

const MOTION_LABEL: Record<MotionSetting, string> = {
  system: 'System',
  full: 'Full',
  reduced: 'Reduced',
  off: 'Off',
};

export function SettingsView() {
  const { setting: theme, setTheme } = useTheme();
  const motion = usePreference(motionPreference);
  return (
    <Page className="max-w-2xl">
      <PageHeader title="Settings" />
      <section className="flex flex-col divide-y divide-line rounded-panel border border-line bg-bg-1 shadow-raised">
        <SettingRow title="Theme" description="System follows your OS appearance.">
          <Segmented
            label="Theme"
            options={THEME_SETTINGS}
            labels={THEME_LABEL}
            value={theme}
            onChange={setTheme}
          />
        </SettingRow>
        <SettingRow
          title="Motion"
          description="Reduced keeps cross-fades only. Off stops every animation."
        >
          <Segmented
            label="Motion"
            options={MOTION_SETTINGS}
            labels={MOTION_LABEL}
            value={motion}
            onChange={motionPreference.set}
          />
        </SettingRow>
      </section>
    </Page>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-medium text-body text-text-1">{title}</h2>
        <p className="text-label text-text-3">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange(value: T): void;
}) {
  return (
    <fieldset className="flex shrink-0 self-start rounded-control border border-line bg-bg-0 p-0.5 sm:self-auto">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={cx(
            'h-7 rounded-chip px-3 text-label transition-colors duration-150',
            option === value
              ? 'bg-bg-2 text-text-1 shadow-raised'
              : 'text-text-2 hover:text-text-1',
          )}
        >
          {labels[option]}
        </button>
      ))}
    </fieldset>
  );
}
