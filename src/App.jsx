import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

const revenueData = [
  { month: 'Jan', revenue: 18, target: 16 },
  { month: 'Feb', revenue: 22, target: 19 },
  { month: 'Mar', revenue: 26, target: 21 },
  { month: 'Apr', revenue: 30, target: 25 },
  { month: 'May', revenue: 35, target: 28 },
  { month: 'Jun', revenue: 41, target: 34 },
  { month: 'Jul', revenue: 45, target: 38 },
  { month: 'Aug', revenue: 49, target: 42 },
  { month: 'Sep', revenue: 52, target: 47 },
  { month: 'Oct', revenue: 57, target: 50 },
  { month: 'Nov', revenue: 61, target: 54 },
  { month: 'Dec', revenue: 68, target: 58 },
]

const pipelineData = [
  { name: 'Discovery', value: 12 },
  { name: 'Preclinical', value: 16 },
  { name: 'Phase I', value: 20 },
  { name: 'Phase II', value: 28 },
  { name: 'Phase III', value: 35 },
  { name: 'Filed', value: 9 },
  { name: 'Approved', value: 6 },
]

const catalysts = [
  { name: 'NVRA-214', status: 'Phase III', days: 18, type: 'PFS readout' },
  { name: 'ATL-Gx1', status: 'Filed', days: 36, type: 'PDUFA' },
  { name: 'PMB-40', status: 'Phase III', days: 62, type: 'Weight-loss data' },
  { name: 'KTV-3', status: 'Phase III', days: 88, type: 'Clinical cure' },
]

const summary = [
  { label: 'Pipeline value', value: '$2.8B', delta: '+18.4%' },
  { label: 'Cash runway', value: '22.6 mo', delta: '+3.1 mo' },
  { label: 'Next catalyst', value: '18 days', delta: 'NVRA-214' },
  { label: 'Approval odds', value: '42.3%', delta: '+4.2 pts' },
]

function App() {
  return (
    <main className="dashboard-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Biotech intelligence</p>
          <h1>Readout</h1>
        </div>
        <nav className="nav-pills" aria-label="Main navigation">
          <button className="nav-pill active">Overview</button>
          <button className="nav-pill">Pipeline</button>
          <button className="nav-pill">Catalysts</button>
          <button className="nav-pill">Comparables</button>
        </nav>
      </header>

      <section className="summary-grid">
        {summary.map((item) => (
          <article className="summary-card" key={item.label}>
            <span className="label">{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.delta}</small>
          </article>
        ))}
      </section>

      <section className="panel-grid">
        <article className="panel panel-large">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Revenue track</p>
              <h2>Commercial momentum</h2>
            </div>
            <span className="badge positive">+24.1%</span>
          </div>

          <div className="chart-wrap chart-tall">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revenueData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#55d6d1" stopOpacity={0.7} />
                    <stop offset="100%" stopColor="#55d6d1" stopOpacity={0.08} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#dfeaf2" strokeDasharray="4 4" vertical={false} />
                <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: '#58707d', fontSize: 12 }} />
                <YAxis tickLine={false} axisLine={false} tick={{ fill: '#58707d', fontSize: 12 }} />
                <Tooltip
                  formatter={(value) => [`$${value}M`, '']}
                  contentStyle={{ borderRadius: 12, border: '1px solid #dfeaf2', background: '#fff' }}
                />
                <Area type="monotone" dataKey="revenue" stroke="#0d9488" strokeWidth={3} fill="url(#revenueFill)" />
                <Line type="monotone" dataKey="target" stroke="#7c3aed" strokeWidth={2} dot={false} strokeDasharray="6 6" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Stage mix</p>
              <h2>Pipeline by phase</h2>
            </div>
          </div>

          <div className="chart-wrap compact">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pipelineData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="#dfeaf2" strokeDasharray="4 4" vertical={false} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: '#58707d', fontSize: 11 }} />
                <YAxis tickLine={false} axisLine={false} tick={{ fill: '#58707d', fontSize: 11 }} />
                <Tooltip formatter={(value) => [`${value}%`, 'Share']} contentStyle={{ borderRadius: 12, border: '1px solid #dfeaf2', background: '#fff' }} />
                <Bar dataKey="value" radius={[8, 8, 0, 0]} fill="#0c5670" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>
      </section>

      <section className="panel lower-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Catalyst watch</p>
            <h2>Readouts in the next 90 days</h2>
          </div>
        </div>

        <div className="catalyst-list">
          {catalysts.map((item) => (
            <div className="catalyst-item" key={item.name}>
              <div>
                <strong>{item.name}</strong>
                <span>{item.type}</span>
              </div>
              <span className="status-pill">{item.status}</span>
              <span className="days">{item.days} days</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

export default App
