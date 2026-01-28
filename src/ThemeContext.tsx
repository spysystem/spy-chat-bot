import {createContext, useContext, useState, useEffect, type ReactNode, JSX} from 'react';

type Theme = 'dark' | 'light';

interface ThemeContextType {
	theme: Theme;
	toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({children}: { children: ReactNode }): JSX.Element {
	const [theme, setTheme] = useState<Theme>('dark');

	useEffect(() => {
		// Load theme from localStorage or use dark as default
		const savedTheme = localStorage.getItem('theme') as Theme | null;
		if (savedTheme) {
			setTheme(savedTheme);
		}
	}, []);

	useEffect(() => {
		// Apply theme class to document
		document.documentElement.setAttribute('data-theme', theme);
		localStorage.setItem('theme', theme);
	}, [theme]);

	function toggleTheme(): void {
		setTheme((previous) => (previous === 'dark' ? 'light' : 'dark'));
	}

	return (
		<ThemeContext.Provider value={{theme, toggleTheme}}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextType {
	const context = useContext(ThemeContext);
	if (context === undefined) {
		throw new Error('useTheme must be used within a ThemeProvider');
	}
	return context;
}
