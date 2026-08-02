import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.vtrpdv.motoboy',
  appName: 'VTR Motoboy',
  webDir: 'www',
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#2563eb',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
  },
};

export default config;
