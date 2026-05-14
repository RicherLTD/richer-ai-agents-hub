import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/layout/AppLayout";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import Index from "./pages/Index.tsx";
import Leads from "./pages/Leads.tsx";
import Conversations from "./pages/Conversations.tsx";
import Prompts from "./pages/Prompts.tsx";
import Coach from "./pages/Coach.tsx";
import Settings from "./pages/Settings.tsx";
import Login from "./pages/Login.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* Public route — login lives outside the protected layout. */}
            <Route path="/login" element={<Login />} />

            {/* Protected routes — wrapped in AppLayout (sidebar + header)
                and gated by ProtectedRoute. */}
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Index />} />
              <Route path="/leads" element={<Leads />} />
              <Route path="/conversations" element={<Conversations />} />
              <Route path="/conversations/:id" element={<Conversations />} />
              {/* /analytics merged into the home page as an admin tab. Old
                  links redirect home rather than 404. */}
              <Route path="/analytics" element={<Navigate to="/" replace />} />
              <Route path="/prompts" element={<Prompts />} />
              <Route path="/coach" element={<Coach />} />
              <Route path="/settings" element={<Settings />} />
            </Route>

            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
