import { useState, useEffect } from 'react';
import { Eye, EyeOff, Save, Zap, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/endpoints';

function MaskedInput({ id, label, value, onChange, placeholder, disabled }) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="input pr-10"
          autoComplete="off"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
          title={visible ? 'Hide' : 'Show'}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
}

export default function Settings() {
  const [form, setForm] = useState({
    whatsappPhoneNumberId: '',
    whatsappToken: '',
    shopifyStoreUrl: '',
    shopifyWebhookSecret: '',
  });
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [testing, setTesting]   = useState(false);
  const [testResult, setTestResult] = useState(null); // { success, message }

  // Load current settings on mount
  useEffect(() => {
    (async () => {
      try {
        const data = await api.getSettings();
        setForm({
          whatsappPhoneNumberId: data.whatsappPhoneNumberId || '',
          whatsappToken:         data.whatsappToken || '',
          shopifyStoreUrl:       data.shopifyStoreUrl || '',
          shopifyWebhookSecret:  data.shopifyWebhookSecret || '',
        });
      } catch (err) {
        toast.error(`Failed to load settings: ${err.message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleChange = (key) => (value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.saveSettings(form);
      toast.success('Settings saved successfully!');
    } catch (err) {
      toast.error(`Failed to save: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testWhatsApp();
      setTestResult({
        success: true,
        message: `✓ Connected — ${result.phoneNumber || 'Phone verified'} (${result.qualityRating || 'N/A'} quality)`,
      });
      toast.success('WhatsApp connection verified!');
    } catch (err) {
      setTestResult({ success: false, message: err.message });
      toast.error('Connection test failed');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 animate-slide-up">
        <div className="page-header">
          <div className="skeleton h-7 w-32 mb-2" />
          <div className="skeleton h-4 w-64" />
        </div>
        <div className="max-w-xl card p-8 space-y-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <div className="skeleton h-3 w-40 mb-2" />
              <div className="skeleton h-10 w-full rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 animate-slide-up">
      {/* ── Header ── */}
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">
          Configure your WhatsApp and Shopify integration credentials
        </p>
      </div>

      <div className="max-w-xl">
        <form onSubmit={handleSave} className="card p-8 space-y-6">

          {/* ── WhatsApp section ── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-whatsapp-500 inline-block" />
              WhatsApp Business Cloud API
            </h2>
            <div className="space-y-4">
              <div>
                <label htmlFor="wa-phone-id" className="block text-sm font-medium text-gray-700 mb-1.5">
                  Phone Number ID
                </label>
                <input
                  id="wa-phone-id"
                  type="text"
                  value={form.whatsappPhoneNumberId}
                  onChange={(e) => handleChange('whatsappPhoneNumberId')(e.target.value)}
                  placeholder="e.g. 1234567890123456"
                  className="input"
                />
              </div>

              <MaskedInput
                id="wa-token"
                label="Access Token"
                value={form.whatsappToken}
                onChange={handleChange('whatsappToken')}
                placeholder="EAAxxxxxxx… (leave unchanged to keep current)"
              />
            </div>
          </div>

          <hr className="border-gray-100" />

          {/* ── Shopify section ── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
              Shopify
            </h2>
            <div className="space-y-4">
              <div>
                <label htmlFor="shopify-url" className="block text-sm font-medium text-gray-700 mb-1.5">
                  Store URL
                </label>
                <input
                  id="shopify-url"
                  type="url"
                  value={form.shopifyStoreUrl}
                  onChange={(e) => handleChange('shopifyStoreUrl')(e.target.value)}
                  placeholder="https://your-store.myshopify.com"
                  className="input"
                />
              </div>

              <MaskedInput
                id="shopify-secret"
                label="Webhook Secret"
                value={form.shopifyWebhookSecret}
                onChange={handleChange('shopifyWebhookSecret')}
                placeholder="shpss_xxxxxxxx… (leave unchanged to keep current)"
              />
            </div>
          </div>

          <hr className="border-gray-100" />

          {/* ── Test result ── */}
          {testResult && (
            <div
              className={`flex items-start gap-3 p-4 rounded-xl text-sm ${
                testResult.success
                  ? 'bg-emerald-50 text-emerald-800'
                  : 'bg-red-50 text-red-800'
              }`}
            >
              {testResult.success ? (
                <CheckCircle size={16} className="text-emerald-600 mt-0.5 shrink-0" />
              ) : (
                <XCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}

          {/* ── Actions ── */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="btn-primary"
              id="save-settings-btn"
            >
              {saving ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Save size={15} />
              )}
              {saving ? 'Saving…' : 'Save Settings'}
            </button>

            <button
              type="button"
              id="test-whatsapp-btn"
              onClick={handleTest}
              disabled={testing}
              className="btn-secondary"
            >
              {testing ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Zap size={15} />
              )}
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
          </div>
        </form>

        {/* ── Help callout ── */}
        <div className="mt-5 card p-5 bg-slate-50 border-slate-100">
          <p className="text-xs font-semibold text-slate-600 mb-2">ℹ️ Where to find these values</p>
          <ul className="text-xs text-slate-500 space-y-1">
            <li>• <strong>Phone Number ID</strong>: Meta for Developers → Your App → WhatsApp → API Setup</li>
            <li>• <strong>Access Token</strong>: Meta for Developers → Your App → WhatsApp → API Setup → Temporary / Permanent token</li>
            <li>• <strong>Webhook Secret</strong>: Shopify Admin → Settings → Notifications → Webhooks (shown when creating a webhook)</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
