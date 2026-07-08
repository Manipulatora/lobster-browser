import { CheckCircleIcon } from '@heroicons/react/24/outline';

const PLANS = [
  {
    name: 'Starter',
    price: '$49',
    current: true,
    details: ['25 profiles', '1 seat', 'Local automation API'],
  },
  {
    name: 'Team',
    price: '$149',
    current: false,
    details: ['200 profiles', '5 seats', 'Template sharing', 'Priority proxy checks'],
  },
  {
    name: 'Scale',
    price: 'Custom',
    current: false,
    details: ['Custom limits', 'Dedicated support', 'Managed onboarding'],
  },
];

export function PricingView(): JSX.Element {
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Pricing</h1>
          <p>Plan limits, seats, automation access, and billing state.</p>
        </div>
        <span className="plan-badge">Trial active</span>
      </header>

      <div className="usage-band">
        <div>
          <span className="metric-label">Profiles</span>
          <strong>3 / 25</strong>
        </div>
        <div>
          <span className="metric-label">Seats</span>
          <strong>1 / 1</strong>
        </div>
        <div>
          <span className="metric-label">API calls</span>
          <strong>1.2k / 10k</strong>
        </div>
      </div>

      <div className="pricing-grid">
        {PLANS.map((plan) => (
          <article
            key={plan.name}
            className={plan.current ? 'plan-card plan-card--active' : 'plan-card'}
          >
            <header>
              <h2>{plan.name}</h2>
              <strong>{plan.price}</strong>
            </header>
            <ul>
              {plan.details.map((detail) => (
                <li key={detail}>
                  <CheckCircleIcon aria-hidden />
                  {detail}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={plan.current ? 'btn btn--secondary' : 'btn btn--primary'}
            >
              {plan.current ? 'Current plan' : 'Upgrade'}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
