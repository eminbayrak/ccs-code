What CCS Code does                                      
                                                          
  It's a local knowledge base CLI. You point it at your   
  files, it processes them into structured wiki pages, and
   makes that knowledge queryable. Right now your vault   
  has:                                                    
                                                          
  - 430 conversation pages from your Claude export        
  - 2 Gemini HTML pages
  - A knowledge graph showing topic clusters (code, ai,   
  design, writing, etc.)                                  
   
  How it relates information                              
                                                        
  Currently it links conversations by shared keywords in  
  titles/summaries. That's shallow. The deeper design
  (from your original docs) is:                           
                                                        
  raw/          ← dump anything here (PDFs, code, docs,
  exports)                                                
      ↓ /ingest
  wiki/          ← structured .md pages with [[wikilinks]]
   between entities                                       
      ↓ /graph                                            
  output/graph.html  ← visual map of everything and how it
   connects                                               
   
  The wiki pages use [[wikilinks]] — if two pages both    
  mention "React hooks", they get an edge in the graph. 
  Right now those links are keyword-inferred, not         
  semantic.                                             

  ---
  How to integrate with AI tools

  There are three real integration patterns:

  1. Claude (easiest — you're already set up)             
  The vault has a CLAUDE.md file. Claude Code reads that
  automatically when you run it from the vault directory: 
  cd ~/Downloads/AI/Takeout                             
  claude   # Claude reads CLAUDE.md and knows your        
  knowledge base context                                  
  Put a summary of your wiki in CLAUDE.md and Claude will
  use it in every conversation.                           
                                                          
  2. GitHub Copilot / VS Code
  Copilot reads files open in your editor. The trick is to
   open your wiki pages alongside your code:              
  - Put relevant wiki/*.md files in your workspace
  - Copilot picks them up as context automatically        
  - Or use Copilot Chat: @workspace searches all open   
  files including your wiki                               
                                                          
  3. OpenAI / Codex / API (your UHG Azure setup)
  Add a /ask flow to CCS Code that does RAG — search the  
  wiki for relevant pages, inject them as context, then   
  call the model:                                         
  user asks question                                      
      ↓                                                 
  search wiki/*.md for matching pages (keyword match)
      ↓                                              
  inject top 3-5 pages into system prompt                 
      ↓                                  
  send to your Azure OpenAI endpoint                      
      ↓                                                 
  model answers with your knowledge base as context       
  
  4. Anthropic MCP (most powerful)                        
  Claude supports MCP (Model Context Protocol) — you    
  expose your vault as an MCP server and Claude can query 
  it like a tool. I can build this if you want. 