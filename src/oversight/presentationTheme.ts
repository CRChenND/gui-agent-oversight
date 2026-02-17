export interface OversightPresentationTheme {
  riskColors: {
    low: string;
    medium: string;
    high: string;
  };
  modalLayout: 'compact' | 'standard';
  panelDefaultExpansion: 'collapsed' | 'expanded';
  lockedInExperimentMode: boolean;
}

export const EXPERIMENT_PRESENTATION_THEME: OversightPresentationTheme = {
  riskColors: {
    low: '#3a7a4a',
    medium: '#ad8a2a',
    high: '#b13a3a',
  },
  modalLayout: 'standard',
  panelDefaultExpansion: 'expanded',
  lockedInExperimentMode: true,
};

export const DEFAULT_PRESENTATION_THEME: OversightPresentationTheme = {
  riskColors: {
    low: '#3a7a4a',
    medium: '#ad8a2a',
    high: '#b13a3a',
  },
  modalLayout: 'standard',
  panelDefaultExpansion: 'collapsed',
  lockedInExperimentMode: false,
};
