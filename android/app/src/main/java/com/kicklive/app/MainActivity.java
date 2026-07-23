package com.kicklive.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(KickLiveUpdater.class);
        super.onCreate(savedInstanceState);
    }
}
