'use client';

import { useState, useRef, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { ExtractedComp } from '@/types';
import { Upload, Send, FileText, CheckCircle, AlertCircle, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  comps?: ExtractedComp[];
  timestamp: string;
}

export default function ImportPage() {
  const [messages, setMessages] = useState<Message[]>([{
    role: 'assistant',
    content: "Hi! I'm ready to help you import comps. Upload a PDF, paste text from an appraisal or closing statement, or share a property description. I'll extract the comparable sales data automatically.",
    timestamp: new Date().toISOString(),
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingComps, setPendingComps] = useState<ExtractedComp[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const isDocumentPaste = (text: string): boolean => {
    if (text.length < 150) return false;
    const patterns = [
      /sale price/i, /acres/i, /county/i, /grantor/i, /grantee/i,
      /recording number/i, /price per acre/i, /land sale/i,
      /property identification/i, /transaction data/i, /sale date/i,
    ];
    return patterns.filter(p => p.test(text)).length >= 3;
  };

  const sendMessage = async (text: string, fileContent?: string) => {
    const userMessage: Message = {
      role: 'user',
      content: fileContent ? `[Document uploaded]\n${text}` : text,
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/import-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(m => ({
            role: m.role,
            content: m.content,
          })),
          documentContent: fileContent || (isDocumentPaste(text) ? text : undefined),
        }),
      });

      const data = await response.json();

      const assistantMessage: Message = {
        role: 'assistant',
        content: data.message,
        comps: data.comps,
        timestamp: new Date().toISOString(),
      };

      setMessages(prev => [...prev, assistantMessage]);

      if (data.comps && data.comps.length > 0) {
        setPendingComps(prev => [...prev, ...data.comps]);
      }
    } catch (error) {
      toast.error('Failed to process message');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setLoading(true);
    try {
      const response = await fetch('/api/parse-pdf', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();

      if (data.text) {
        await sendMessage(`Uploaded: ${file.name}`, data.text);
      } else {
        toast.error('Could not read document');
      }
    } catch {
      toast.error('Failed to upload file');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!input.trim() || loading) return;
    await sendMessage(input.trim());
  };

  const saveComp = async (comp: ExtractedComp) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase.from('comps').insert({
      created_by: user.id,
      property_name: comp.property_name,
      county: comp.county || '',
      state: comp.state || 'TX',
      acres: comp.acres || 0,
      sale_price: comp.sale_price || 0,
      improvements_value: comp.improvements_value,
      sale_date: comp.sale_date,
      address: comp.address,
      latitude: comp.latitude,
      longitude: comp.longitude,
      parcel_id: comp.parcel_id,
      recording_number: comp.recording_number,
      grantor: comp.grantor,
      grantee: comp.grantee,
      financing: comp.financing,
      minerals_sold: comp.minerals_sold,
      confirmation_source: comp.confirmation_source,
      description: comp.description,
      water: comp.water || 'None',
      road_frontage: comp.road_frontage || 'None',
      has_improvements: comp.has_improvements || false,
      improvements_notes: comp.improvements_notes,
      wildlife_notes: comp.wildlife_notes,
      flood_plain_pct: comp.flood_plain_pct,
      status: 'Sold',
      visibility: 'team',
      confidence: comp.confidence.overall > 80 ? 'Verified' : comp.confidence.overall > 50 ? 'Estimated' : 'Unverified',
    });

    if (error) {
      toast.error('Failed to save comp');
    } else {
      toast.success(`${comp.property_name || 'Comp'} added to vault!`);
      setPendingComps(prev => prev.filter(c => c !== comp));
    }
  };

  const saveAllComps = async () => {
    for (const comp of pendingComps) {
      await saveComp(comp);
    }
  };

  return (
    <div className="flex h-full bg-night">
      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="flex-shrink-0 bg-panel border-b border-border px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sage/10 border border-sage/20 flex items-center justify-center">
            <FileText size={15} className="text-sage" />
          </div>
          <div>
            <h1 className="font-bold text-sm">Import Comps</h1>
            <p className="text-xs text-slate-500">Upload PDF, paste text, or describe a property</p>
          </div>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-card border border-border rounded-lg text-xs font-bold text-slate-300 hover:text-white hover:border-sage transition-colors"
            >
              <Upload size={12} />
              Upload PDF
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
            />
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-sage/10 border border-sage/20 text-white'
                  : 'bg-card border border-border text-slate-200'
              }`}>
                {msg.role === 'assistant' && (
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="w-4 h-4 rounded bg-sage/20 flex items-center justify-center">
                      <span className="text-sage text-[8px] font-bold">AI</span>
                    </div>
                    <span className="text-xs font-bold text-sage">Landstack AI</span>
                  </div>
                )}
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>

                {/* Extracted comps */}
                {msg.comps && msg.comps.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {msg.comps.map((comp, ci) => (
                      <div key={ci} className="bg-night border border-border rounded-xl p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <p className="text-sm font-bold text-white">
                              {comp.property_name || `${comp.county} County — ${comp.acres} ac`}
                            </p>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {comp.county}, {comp.state} · {comp.acres} acres
                            </p>
                            <div className="flex items-center gap-3 mt-1.5">
                              <span className="text-emerald-400 font-mono text-xs font-bold">
                                ${comp.sale_price?.toLocaleString()}
                              </span>
                              {comp.ppa_land_only && (
                                <span className="text-emerald-400 font-mono text-xs">
                                  ${Math.round(comp.ppa_land_only).toLocaleString()}/ac (land)
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <div className={`w-2 h-2 rounded-full ${
                              comp.confidence.overall >= 80 ? 'bg-emerald-400' :
                              comp.confidence.overall >= 50 ? 'bg-amber-400' : 'bg-red-400'
                            }`} />
                            <span className="text-xs text-slate-500">{comp.confidence.overall}%</span>
                          </div>
                        </div>
                        <button
                          onClick={() => saveComp(comp)}
                          className="mt-2 w-full py-1.5 bg-sage/10 hover:bg-sage/20 border border-sage/20 text-sage rounded-lg text-xs font-bold transition-colors"
                        >
                          + Add to Vault
                        </button>
                      </div>
                    ))}

                    {msg.comps.length > 1 && (
                      <button
                        onClick={saveAllComps}
                        className="w-full py-2 bg-sage hover:bg-sage2 text-black rounded-xl text-xs font-bold transition-colors"
                      >
                        Add All {msg.comps.length} Comps to Vault
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-card border border-border rounded-2xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded bg-sage/20 flex items-center justify-center">
                    <span className="text-sage text-[8px] font-bold">AI</span>
                  </div>
                  <div className="flex gap-1">
                    <div className="w-1.5 h-1.5 bg-sage rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-1.5 h-1.5 bg-sage rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-1.5 h-1.5 bg-sage rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex-shrink-0 bg-panel border-t border-border p-3">
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2.5 bg-card border border-border rounded-xl text-slate-400 hover:text-sage hover:border-sage transition-colors flex-shrink-0"
            >
              <Upload size={16} />
            </button>
            <div className="flex-1 relative">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder="Paste appraisal text, describe a sale, or ask a question..."
                rows={1}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sage transition-colors resize-none"
                style={{ minHeight: '42px', maxHeight: '120px' }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = Math.min(target.scrollHeight, 120) + 'px';
                }}
              />
            </div>
            <button
              onClick={handleSubmit}
              disabled={loading || !input.trim()}
              className="p-2.5 bg-sage hover:bg-sage2 text-black rounded-xl transition-colors flex-shrink-0 disabled:opacity-50"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="text-[10px] text-slate-600 mt-1.5 text-center">
            Paste from email, upload PDF, or take a photo · Press Enter to send
          </p>
        </div>
      </div>
    </div>
  );
}
