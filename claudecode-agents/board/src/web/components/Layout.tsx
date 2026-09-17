import { Outlet } from 'react-router-dom';
import SideNavigation from './SideNavigation';
import Navigation from './Navigation';
import { HealthIndicator, HealthSuccessToast } from './HealthIndicator';
import { type Task, type Document, type Decision } from '../../types';

interface LayoutProps {
	projectName: string;
	showSuccessToast: boolean;
	onDismissToast: () => void;
	tasks: Task[];
	docs: Document[];
	decisions: Decision[];
	isLoading: boolean;
	error?: Error | null;
	onRefreshData: () => Promise<void>;
}

export default function Layout({
	projectName,
	showSuccessToast,
	onDismissToast,
	tasks,
	docs,
	decisions,
	isLoading,
	error,
	onRefreshData,
}: LayoutProps) {
	return (
		<div className="h-screen bg-gray-50 dark:bg-gray-900 flex overflow-hidden transition-colors duration-200">
			<HealthIndicator />
			<SideNavigation 
				taskCount={tasks.length}
				docs={docs}
				decisions={decisions}
				isLoading={isLoading}
				error={error}
				onRetry={onRefreshData}
				onRefreshData={onRefreshData}
			/>
			<div className="flex-1 flex flex-col min-h-0 min-w-0">
				<Navigation projectName={projectName} />
				<main className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
					<Outlet context={{ tasks, docs, decisions, isLoading, onRefreshData }} />
				</main>
			</div>
			{showSuccessToast && (
				<HealthSuccessToast onDismiss={onDismissToast} />
			)}
		</div>
	);
}
