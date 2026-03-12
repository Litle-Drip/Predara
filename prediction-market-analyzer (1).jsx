import { useState, useEffect, useRef } from "react";

const SYSTEM_PROMPT = `You are a prediction market analyst. The user will give you a URL to a prediction market event (from Kalshi, Polymarket, Coinbase, Gemini, Manifold, etc.).

Use the web_search tool to fetch and analyze the page at that URL. Extract ALL of the following information and return ONLY a valid JSON object — no markdown fences, no explanation, just raw JSON.

Return this exact structure:
{
  "title": "Full event title",
  "platform": "Platform name (Kalshi/Polymarket/etc.)",
  "summary": "One-sentence plain English description of what this bet is about",
  "start_date": "Start date or 'Not specified'",
  "end_date": "End/expiry date or 'Not specified'",
  "resolution_date": "When it will be resolved or 'Not specified'",
  "resolved_by": "Who/what resolves it (e.g. platform admins, oracle, specific committee)",
  "resolution_authority": "The named authority or organization responsible",
  "official_sources": ["list", "of", "official", "sources", "required", "to", "verify"],
  "rules": ["Rule 1", "Rule 2", "Rule 3 - each as a separate string"],
  "sides": [
    { "name": "Yes / outcome name", "probability": 72, "odds": "+138", "description": "what this side means" },
    { "name": "No / other outcome", "probability": 28, "odds": "-138", "description": "what this side means" }
  ],
  "volume_traded": "e.g. $1.2M or 'Not available'",
  "liquidity": "e.g. $45K or 'Not available'",
  "open_interest": "e.g. $800K or 'Not available'",
  "status": "Open / Closed / Resolved",
  "category": "Politics / Crypto / Sports / Finance / Science / Other",
  "error": null
}

If you cannot access the page or find the information, set "error" to a descriptive message string.
If certain fields are genuinely not available on the page, use "Not available" or empty arrays.
Probabilities should be numbers 0-100. Odds can be American format (+/-) or decimal.`;

const ClaudeMark = () => (
  <svg width="20" height="20" viewBox="0 0 36 36" fill="none">
    <path d="M18 2C18 2 20.5 9.5 24 13C27.5 16.5 35 18 35 18C35 18 27.5 19.5 24 23C20.5 26.5 18 34 18 34C18 34 15.5 26.5 12 23C8.5 19.5 1 18 1 18C1 18 8.5 16.5 12 13C15.5 9.5 18 2 18 2Z" fill="#D97757"/>
  </svg>
);

const statusColor = (s) => {
  if (!s) return "#4A4540";
  const l = s.toLowerCase();
  if (l.includes("open")) return "#5EA87A";
  if (l.includes("closed")) return "#D97757";
  if (l.includes("resolved")) return "#7B9FD4";
  return "#4A4540";
};

const sideColors = [
  { bar: "#5EA87A", label: "#B8DFC4" },
  { bar: "#D97757", label: "#F0C4B0" },
];

export default function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [stageIdx, setStageIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const stages = ["Connecting to market…", "Reading event data…", "Extracting rules & odds…", "Structuring results…"];

  useEffect(() => {
    let iv;
    if (loading) iv = setInterval(() => setStageIdx(s => (s + 1) % stages.length), 1800);
    else setStageIdx(0);
    return () => clearInterval(iv);
  }, [loading]);

  useEffect(() => {
    if (data) setTimeout(() => setRevealed(true), 60);
    else setRevealed(false);
  }, [data]);

  const analyze = async () => {
    if (!url.trim()) return;
    setLoading(true); setData(null); setError(null);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: `Analyze this prediction market event: ${url.trim()}` }]
        })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || "API request failed");
      const raw = result.content.filter(b => b.type === "text").map(b => b.text).join("");
      let parsed;
      try {
        const clean = raw.replace(/```json|```/g, "").trim();
        const match = clean.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : clean);
      } catch { throw new Error("Could not parse market data. The page may require login or the URL may be invalid."); }
      if (parsed.error) throw new Error(parsed.error);
      setData(parsed);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;1,300&family=DM+Mono:wght@300;400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .c-reveal{opacity:0;transform:translateY(10px);transition:opacity .4s ease,transform .4s ease}
        .c-reveal.on{opacity:1;transform:translateY(0)}
        .c-reveal:nth-child(1){transition-delay:.04s}.c-reveal:nth-child(2){transition-delay:.10s}
        .c-reveal:nth-child(3){transition-delay:.17s}.c-reveal:nth-child(4){transition-delay:.24s}
        .c-reveal:nth-child(5){transition-delay:.31s}.c-reveal:nth-child(6){transition-delay:.38s}
        .c-reveal:nth-child(7){transition-delay:.45s}
        .url-inp{flex:1;background:rgba(255,255,255,.05);border:0.5px solid rgba(255,255,255,.1);color:#E8E2DA;font-family:'DM Mono',monospace;font-size:12px;border-radius:7px;height:42px;padding:0 14px;outline:none;transition:border-color .15s}
        .url-inp::placeholder{color:rgba(232,226,218,.28)}
        .url-inp:focus{border-color:rgba(217,119,87,.5)}
        .url-inp:disabled{opacity:.4}
        .go-btn{background:#D97757;border:none;color:#1C1612;font-family:'DM Mono',monospace;font-size:11px;font-weight:500;letter-spacing:.09em;padding:0 22px;border-radius:7px;height:42px;cursor:pointer;transition:background .15s,opacity .15s;white-space:nowrap}
        .go-btn:hover:not(:disabled){background:#E8906A}
        .go-btn:disabled{opacity:.35;cursor:default}
        .hdivider{border:none;border-top:0.5px solid rgba(255,255,255,.07);margin:0}
        .trow{display:flex;justify-content:space-between;align-items:flex-start;padding:9px 0;border-bottom:0.5px solid rgba(255,255,255,.07)}
        .trow:last-child{border-bottom:none}
        .src-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:0.5px solid rgba(255,255,255,.06)}
        .src-row:last-child{border-bottom:none}
        .bar-fill{transition:width .85s cubic-bezier(.16,1,.3,1)}
        .pulse-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#D97757;animation:pulse 1.4s ease-in-out infinite;flex-shrink:0}
      `}</style>

      <div style={{background:"#1B1612",minHeight:"100vh",padding:"26px 22px",fontFamily:"'DM Mono',monospace"}}>

        {/* Header */}
        <div style={{display:"flex",alignItems:"center",gap:11,marginBottom:26}}>
          <ClaudeMark />
          <div>
            <div style={{fontFamily:"'Crimson Pro',serif",fontSize:"19px",fontWeight:400,color:"#E8E2DA",letterSpacing:".01em",lineHeight:1}}>Market Intelligence</div>
            <div style={{fontSize:"9px",color:"rgba(232,226,218,.28)",letterSpacing:".13em",marginTop:3}}>PREDICTION ANALYZER · CLAUDE BY ANTHROPIC</div>
          </div>
        </div>

        {/* URL input row */}
        <div style={{display:"flex",gap:8,marginBottom:26}}>
          <input className="url-inp" type="url" placeholder="paste a kalshi, polymarket, manifold url…"
            value={url} onChange={e=>setUrl(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&analyze()} disabled={loading} />
          <button className="go-btn" onClick={analyze} disabled={loading||!url.trim()}>
            {loading ? "READING" : "ANALYZE ↗"}
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{padding:"36px 0",display:"flex",justifyContent:"center"}}>
            <div style={{display:"inline-flex",alignItems:"center",gap:10,background:"rgba(255,255,255,.04)",border:"0.5px solid rgba(255,255,255,.09)",borderRadius:8,padding:"11px 20px"}}>
              <span className="pulse-dot" />
              <span style={{fontSize:"11px",color:"#D97757",letterSpacing:".07em"}}>{stages[stageIdx]}</span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{padding:"13px 16px",borderRadius:8,background:"rgba(217,119,87,.09)",border:"0.5px solid rgba(217,119,87,.3)",color:"#F0C4B0",fontSize:"11px",letterSpacing:".03em",lineHeight:1.65}}>
            <span style={{color:"#D97757",marginRight:8}}>⚠</span>{error}
          </div>
        )}

        {/* Results */}
        {data && (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>

            {/* Title card */}
            <div className={`c-reveal${revealed?" on":""}`} style={{background:"rgba(217,119,87,.07)",border:"0.5px solid rgba(217,119,87,.22)",borderRadius:10,padding:"18px 20px"}}>
              <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap",marginBottom:10}}>
                {data.platform && <span style={{fontSize:"9px",letterSpacing:".13em",color:"#D97757",background:"rgba(217,119,87,.14)",padding:"3px 8px",borderRadius:4}}>{data.platform.toUpperCase()}</span>}
                {data.category && <span style={{fontSize:"9px",color:"rgba(232,226,218,.35)",letterSpacing:".1em"}}>{data.category.toUpperCase()}</span>}
                {data.status && (
                  <span style={{display:"flex",alignItems:"center",gap:5,fontSize:"9px",color:"rgba(232,226,218,.35)",letterSpacing:".1em"}}>
                    <span style={{width:5,height:5,borderRadius:"50%",background:statusColor(data.status),display:"inline-block"}}/>
                    {data.status.toUpperCase()}
                  </span>
                )}
              </div>
              <div style={{fontFamily:"'Crimson Pro',serif",fontSize:"20px",fontWeight:400,color:"#E8E2DA",lineHeight:1.35,marginBottom:8}}>{data.title}</div>
              {data.summary&&<div style={{fontSize:"11px",color:"rgba(232,226,218,.48)",lineHeight:1.7,letterSpacing:".02em"}}>{data.summary}</div>}
            </div>

            {/* Outcomes */}
            {data.sides?.length>0&&(
              <div className={`c-reveal${revealed?" on":""}`} style={{background:"rgba(255,255,255,.03)",border:"0.5px solid rgba(255,255,255,.08)",borderRadius:10,padding:"18px 20px"}}>
                <div style={{fontSize:"9px",letterSpacing:".14em",color:"rgba(232,226,218,.3)",marginBottom:16}}>OUTCOMES & PROBABILITY</div>
                <div style={{display:"flex",flexDirection:"column",gap:16}}>
                  {data.sides.map((side,i)=>{
                    const col=sideColors[i]||sideColors[1];
                    const prob=Math.max(0,Math.min(100,side.probability??50));
                    return (
                      <div key={i}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
                          <div style={{display:"flex",flexDirection:"column",gap:2}}>
                            <span style={{fontSize:"13px",fontWeight:500,color:col.label,letterSpacing:".02em"}}>{side.name}</span>
                            {side.description&&<span style={{fontSize:"10px",color:"rgba(232,226,218,.3)"}}>{side.description}</span>}
                          </div>
                          <div style={{display:"flex",gap:12,alignItems:"baseline",flexShrink:0,marginLeft:16}}>
                            {side.odds&&<span style={{fontSize:"10px",color:"rgba(232,226,218,.35)",fontFamily:"'DM Mono',monospace"}}>{side.odds}</span>}
                            <span style={{fontFamily:"'Crimson Pro',serif",fontSize:"22px",fontWeight:300,color:col.bar}}>{prob}%</span>
                          </div>
                        </div>
                        <div style={{height:4,background:"rgba(255,255,255,.07)",borderRadius:2,overflow:"hidden"}}>
                          <div className="bar-fill" style={{height:"100%",width:`${prob}%`,background:col.bar,borderRadius:2}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Market stats */}
            <div className={`c-reveal${revealed?" on":""}`} style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
              {[{l:"VOLUME TRADED",v:data.volume_traded},{l:"LIQUIDITY",v:data.liquidity},{l:"OPEN INTEREST",v:data.open_interest}].map(({l,v})=>(
                <div key={l} style={{background:"rgba(255,255,255,.03)",border:"0.5px solid rgba(255,255,255,.08)",borderRadius:10,padding:"14px 15px"}}>
                  <div style={{fontSize:"9px",letterSpacing:".13em",color:"rgba(232,226,218,.28)",marginBottom:8}}>{l}</div>
                  <div style={{fontFamily:"'Crimson Pro',serif",fontSize:"19px",fontWeight:300,color:v&&v!=="Not available"?"#E8E2DA":"rgba(232,226,218,.2)"}}>
                    {v&&v!=="Not available"?v:"—"}
                  </div>
                </div>
              ))}
            </div>

            {/* Timeline */}
            <div className={`c-reveal${revealed?" on":""}`} style={{background:"rgba(255,255,255,.03)",border:"0.5px solid rgba(255,255,255,.08)",borderRadius:10,padding:"18px 20px"}}>
              <div style={{fontSize:"9px",letterSpacing:".14em",color:"rgba(232,226,218,.3)",marginBottom:14}}>TIMELINE</div>
              {[{label:"Start date",value:data.start_date},{label:"End / expiry",value:data.end_date},{label:"Resolution date",value:data.resolution_date}].map(({label,value})=>(
                <div key={label} className="trow">
                  <span style={{fontSize:"11px",color:"rgba(232,226,218,.35)",letterSpacing:".03em"}}>{label}</span>
                  <span style={{fontSize:"11px",color:value&&value!=="Not specified"?"#E8E2DA":"rgba(232,226,218,.2)",fontFamily:"'DM Mono',monospace",textAlign:"right"}}>{value||"—"}</span>
                </div>
              ))}
            </div>

            {/* Resolution */}
            <div className={`c-reveal${revealed?" on":""}`} style={{background:"rgba(255,255,255,.03)",border:"0.5px solid rgba(255,255,255,.08)",borderRadius:10,padding:"18px 20px"}}>
              <div style={{fontSize:"9px",letterSpacing:".14em",color:"rgba(232,226,218,.3)",marginBottom:14}}>RESOLUTION</div>
              {[{label:"Resolved by",value:data.resolved_by},{label:"Authority",value:data.resolution_authority}].map(({label,value})=>(
                <div key={label} className="trow">
                  <span style={{fontSize:"11px",color:"rgba(232,226,218,.35)",flexShrink:0,letterSpacing:".03em"}}>{label}</span>
                  <span style={{fontSize:"11px",color:value&&value!=="Not specified"?"#E8E2DA":"rgba(232,226,218,.2)",textAlign:"right",lineHeight:1.55,marginLeft:20}}>{value||"—"}</span>
                </div>
              ))}
            </div>

            {/* Verification sources */}
            {data.official_sources?.length>0&&(
              <div className={`c-reveal${revealed?" on":""}`} style={{background:"rgba(255,255,255,.03)",border:"0.5px solid rgba(255,255,255,.08)",borderRadius:10,padding:"18px 20px"}}>
                <div style={{fontSize:"9px",letterSpacing:".14em",color:"rgba(232,226,218,.3)",marginBottom:14}}>VERIFICATION SOURCES</div>
                {data.official_sources.map((src,i)=>(
                  <div key={i} className="src-row">
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:"#D97757",flexShrink:0,marginTop:2}}>{String(i+1).padStart(2,"0")}</span>
                    <span style={{fontSize:"11px",color:"rgba(232,226,218,.68)",lineHeight:1.65}}>{src}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Rules */}
            {data.rules?.length>0&&(
              <div className={`c-reveal${revealed?" on":""}`} style={{background:"rgba(255,255,255,.03)",border:"0.5px solid rgba(255,255,255,.08)",borderRadius:10,padding:"18px 20px"}}>
                <div style={{fontSize:"9px",letterSpacing:".14em",color:"rgba(232,226,218,.3)",marginBottom:14}}>RULES & CRITERIA</div>
                {data.rules.map((rule,i)=>(
                  <div key={i} className="src-row">
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:"9px",color:"rgba(232,226,218,.22)",flexShrink:0,marginTop:3}}>{String(i+1).padStart(2,"0")}</span>
                    <span style={{fontSize:"11px",color:"rgba(232,226,218,.68)",lineHeight:1.7,letterSpacing:".015em"}}>{rule}</span>
                  </div>
                ))}
              </div>
            )}

          </div>
        )}

        {/* Empty state */}
        {!data&&!loading&&!error&&(
          <div style={{textAlign:"center",padding:"52px 0 24px"}}>
            <div style={{marginBottom:16,opacity:.3,display:"flex",justifyContent:"center"}}><ClaudeMark /></div>
            <div style={{fontSize:"10px",color:"rgba(232,226,218,.22)",letterSpacing:".1em",lineHeight:2.2}}>KALSHI · POLYMARKET · MANIFOLD · GEMINI · COINBASE</div>
            <div style={{fontSize:"10px",color:"rgba(232,226,218,.14)",letterSpacing:".05em",marginTop:6}}>paste a url above to begin analysis</div>
          </div>
        )}

        {/* Footer */}
        <div style={{marginTop:24,paddingTop:14,borderTop:"0.5px solid rgba(255,255,255,.06)",display:"flex",alignItems:"center",gap:8}}>
          <span style={{width:5,height:5,borderRadius:"50%",background:loading?"#D97757":"rgba(94,168,122,.6)",display:"inline-block",flexShrink:0}}/>
          <span style={{fontSize:"9px",color:"rgba(232,226,218,.18)",letterSpacing:".1em"}}>CLAUDE · ANTHROPIC · {new Date().getFullYear()}</span>
        </div>

      </div>
    </>
  );
}
