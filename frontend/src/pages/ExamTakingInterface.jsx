import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/axios';

const ExamTakingInterface = () => {
  const { examId } = useParams();
  const navigate = useNavigate();
  const [exam, setExam] = useState(null);
  const [answers, setAnswers] = useState({});
  const [timeLeft, setTimeLeft] = useState(0);
  const [warnings, setWarnings] = useState(0);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [warningMessage, setWarningMessage] = useState("");
  
  const timerRef = useRef(null);

  const handleCheatingAttempt = React.useCallback(async (message) => {
    setWarningMessage(message);
    setShowWarningModal(true);
    setWarnings(prev => prev + 1);
    
    // Log warning to backend
    try {
      await api.post(`/submissions/${examId}/warning`);
    } catch (e) {
      console.error(e);
    }
  }, [examId]);

  const handleSubmit = React.useCallback(async (e, isAutoSubmitted = false) => {
    if (e) e.preventDefault();
    
    const formattedAnswers = Object.keys(answers).map(qId => ({
      questionId: qId,
      providedAnswer: answers[qId]
    }));

    try {
      const response = await api.post(`/submissions/${examId}/submit`, {
        answers: formattedAnswers,
        isAutoSubmitted,
        cheatWarnings: warnings
      });

      if (response.data.success) {
        alert('Exam submitted successfully!');
        navigate('/home');
      }
    } catch (error) {
      console.error('Submit error:', error);
      alert('Failed to submit exam.');
    }
  }, [answers, examId, navigate, warnings]);

  useEffect(() => {
    // Fetch exam data
    const fetchExam = async () => {
      try {
        const response = await api.get(`/exams/${examId}`);
        const data = response.data;
        if (data.success) {
          setExam(data.data);
          setTimeLeft(data.data.timeLimit * 60); // Convert minutes to seconds
        } else {
          setWarningMessage("Failed to load exam data.");
          setShowWarningModal(true);
        }
      } catch (error) {
        console.error('Failed to fetch exam', error);
        setWarningMessage("Error loading exam. Please check your connection.");
        setShowWarningModal(true);
      }
    };
    fetchExam();
  }, [examId]);

  useEffect(() => {
    // Timer logic
    if (timeLeft > 0) {
      timerRef.current = setInterval(() => {
        setTimeLeft((prev) => prev - 1);
      }, 1000);
    } else if (timeLeft === 0 && exam) {
      // Auto-submit when time expires
      alert("Time is up! Submitting your exam automatically.");
      handleSubmit(null, true);
    }
    
    return () => clearInterval(timerRef.current);
  }, [timeLeft, exam, handleSubmit]);

  useEffect(() => {
    // Anti-cheat: Tab switching and minimizing
    const handleVisibilityChange = () => {
      if (document.hidden) {
        handleCheatingAttempt("You switched tabs or minimized the window. This has been logged.");
      }
    };

    // Anti-cheat: Losing focus (clicking outside window)
    const handleBlur = () => {
      handleCheatingAttempt("You clicked outside the exam window. This has been logged.");
    };

    // Anti-cheat: Disable right-click
    const handleContextMenu = (e) => {
      e.preventDefault();
      handleCheatingAttempt("Right-click is disabled during the exam.");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("contextmenu", handleContextMenu);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [handleCheatingAttempt]);

  const handleAnswerChange = (questionId, value) => {
    setAnswers({
      ...answers,
      [questionId]: value
    });
  };

  if (!exam) return <div className="text-center mt-20">Loading exam...</div>;

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="max-w-4xl mx-auto p-6 my-8 select-none" onCopy={(e) => { e.preventDefault(); handleCheatingAttempt("Copying is disabled."); }} onPaste={(e) => { e.preventDefault(); handleCheatingAttempt("Pasting is disabled."); }}>
      
      <div className="sticky top-0 bg-white shadow-md p-4 flex justify-between items-center z-10 border-b-4 border-blue-500 rounded-b-md">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">{exam.title}</h2>
          <p className="text-sm text-gray-500">Warnings: <span className="font-bold text-red-500">{warnings}</span></p>
        </div>
        <div className={`text-2xl font-mono font-bold ${timeLeft < 60 ? 'text-red-600 animate-pulse' : 'text-gray-700'}`}>
          Time Remaining: {formatTime(timeLeft)}
        </div>
      </div>

      <form onSubmit={(e) => handleSubmit(e, false)} className="mt-8">
        {exam.questions.map((q, index) => (
          <div key={q._id} className="bg-white p-6 rounded-lg shadow-sm border mb-6">
            <h3 className="text-lg font-medium mb-4">{index + 1}. {q.questionText}</h3>
            
            {q.type === 'MCQ' && (
              <div className="space-y-3">
                {q.options.map((opt, i) => (
                  <label key={i} className="flex items-center space-x-3 p-3 border rounded-md hover:bg-gray-50 cursor-pointer">
                    <input 
                      type="radio" 
                      name={`question-${q._id}`} 
                      value={opt}
                      checked={answers[q._id] === opt}
                      onChange={() => handleAnswerChange(q._id, opt)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500"
                    />
                    <span>{opt}</span>
                  </label>
                ))}
              </div>
            )}

            {q.type === 'ShortAnswer' && (
              <textarea 
                rows="4" 
                className="w-full p-3 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Type your answer here..."
                value={answers[q._id] || ''}
                onChange={(e) => handleAnswerChange(q._id, e.target.value)}
              />
            )}
          </div>
        ))}

        <button type="submit" className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white text-lg font-bold rounded-lg shadow-md transition duration-200">
          Submit Exam
        </button>
      </form>

      {/* Custom Warning Modal to prevent alert() infinite loops */}
      {showWarningModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-xl max-w-sm w-full text-center border-t-4 border-red-500">
            <h2 className="text-xl font-bold text-red-600 mb-2">Warning!</h2>
            <p className="text-gray-700 mb-6">{warningMessage}</p>
            <button 
              onClick={() => setShowWarningModal(false)}
              className="bg-red-500 hover:bg-red-600 text-white px-6 py-2 rounded-md font-medium"
            >
              I Understand
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExamTakingInterface;
