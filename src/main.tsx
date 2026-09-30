import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {ThemeProvider} from './ThemeContext';
import {LanguageProvider} from './i18n';

const rootElement = document.getElementById('root');

if (!rootElement) {
	throw new Error('Root element not found');
}

createRoot(rootElement).render(
	<StrictMode>
		<ThemeProvider>
			<LanguageProvider>
				<App/>
			</LanguageProvider>
		</ThemeProvider>
	</StrictMode>,
);
