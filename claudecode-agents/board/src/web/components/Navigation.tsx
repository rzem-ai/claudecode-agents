import React from 'react';
import ThemeToggle from './ThemeToggle';

interface NavigationProps {
    projectName: string;
}

const Navigation: React.FC<NavigationProps> = ({projectName}) => {
    return (
        <nav className="relative px-8 h-18 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-colors duration-200">
            <div className="h-full flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{projectName || 'Loading...'}</h1>
                </div>
                <div className="flex items-center gap-3">
                    <ThemeToggle />
                </div>
            </div>
        </nav>
    );
};

export default Navigation;
