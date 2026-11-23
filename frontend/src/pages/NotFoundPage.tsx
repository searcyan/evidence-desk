import { Link } from 'react-router';
import { useI18n } from '../i18n/index.tsx';
import { Button, Card, EmptyState } from '../components/ui.tsx';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-xl px-5 py-16">
      <Card>
        <EmptyState
          title={t('common.notFound')}
          action={
            <Link to="/">
              <Button>{t('nav.new')}</Button>
            </Link>
          }
        />
      </Card>
    </div>
  );
}
