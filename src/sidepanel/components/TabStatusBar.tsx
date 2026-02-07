import React, { useState, useEffect } from 'react';

interface TabStatusBarProps {
  tabId: number | null;
  tabTitle: string;
  tabStatus: 'attached' | 'detached' | 'unknown' | 'running' | 'idle' | 'error';
}

export const TabStatusBar: React.FC<TabStatusBarProps> = ({
  tabId,
  tabTitle,
  tabStatus
}) => {
  const [tabUrl, setTabUrl] = useState<string>('');
  
  // Listen for URL changes only
  useEffect(() => {
    if (!tabId) return;
    
    const statusListener = (
      message: any,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: any) => void
    ) => {
      // Ignore messages from other extensions
      if (sender.id !== chrome.runtime.id) {
        return;
      }
      
      // Only process messages for our tab
      if (message.tabId !== tabId) {
        return;
      }
      
      // Update URL based on message type
      if (message.action === 'targetChanged' && message.url) {
        setTabUrl(message.url);
        sendResponse({ received: true });
      }
      
      return true;
    };
    
    // Add the message listener
    chrome.runtime.onMessage.addListener(statusListener);
    
    // Get initial tab URL
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        console.error('Error getting tab:', chrome.runtime.lastError);
        return;
      }
      
      if (tab && tab.url) {
        setTabUrl(tab.url);
      }
    });
    
    // Clean up the listener when the component unmounts
    return () => {
      chrome.runtime.onMessage.removeListener(statusListener);
    };
  }, [tabId]);
  
  if (!tabId) return null;
  
  // Removed website title click-through per request
  
  return (
    <div className="text-sm bg-base-300 rounded-md px-2 py-1 border border-base-content border-opacity-10 flex items-center max-w-[140px]">
      <div className="flex items-center overflow-hidden">
        <div className={`w-2 h-2 rounded-full mr-2 flex-shrink-0 ${
          tabStatus === 'attached' ? 'bg-green-500 animate-pulse' : 
          tabStatus === 'detached' ? 'bg-red-500' : 
          tabStatus === 'running' ? 'bg-blue-500 animate-pulse' :
          tabStatus === 'idle' ? 'bg-green-500' :
          tabStatus === 'error' ? 'bg-red-500 animate-pulse' : 'bg-yellow-500'
        }`} title={
          tabStatus === 'attached' ? 'Connected' : 
          tabStatus === 'detached' ? 'Disconnected' : 
          tabStatus === 'running' ? 'Agent Running' :
          tabStatus === 'idle' ? 'Agent Idle' :
          tabStatus === 'error' ? 'Agent Error' : 'Unknown'
        }></div>
        {/* Current website display removed per request */}
      </div>
    </div>
  );
};
